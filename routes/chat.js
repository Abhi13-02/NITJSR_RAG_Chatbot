import { createRateLimiter } from '../rate-limiting/rateLimiter.js';
import { getMessage, languageManager } from '../utils/language.js'

/**
 * Extracts and validates chat response fields from the final response object.
 * Ensures consistency between chat route and responseCache logic.
 */
function extractChatResponseFields(finalResponse) {
    const answerText = typeof finalResponse?.answer === 'string' ? finalResponse.answer.trim() : '';
    const sources = Array.isArray(finalResponse?.sources) ? finalResponse.sources : [];
    const relevantLinks = Array.isArray(finalResponse?.relevantLinks) ? finalResponse.relevantLinks : [];
    const confidence =
        typeof finalResponse?.confidence === 'number' && Number.isFinite(finalResponse.confidence)
            ? finalResponse.confidence
            : null;
    return { answerText, sources, relevantLinks, confidence };
}


export function setupChatRoutes(app, server) {

    // SET user's language preference
    app.post('/set-language', async (req, res) => {
        try {
            const { sessionId, language } = req.body;

            if (!sessionId) {
                return res.status(400).json({
                    success: false,
                    error: 'Session ID is required'
                });
            }

            if (!language) {
                return res.status(400).json({
                    success: false,
                    error: 'Language is required'
                });
            }

            if (!['english', 'hindi'].includes(language.toLowerCase())) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid language. Must be "english" or "hindi"'
                });
            }

            const normalizedLanguage = language.toLowerCase();

            // Store language preference (you can extend this to use Redis/MongoDB)
            console.log(`[Language] Set ${sessionId} -> ${normalizedLanguage}`);

            const confirmationMessage = getMessage('languageChanged', normalizedLanguage);

            res.json({
                success: true,
                language: normalizedLanguage,
                message: confirmationMessage,
                sessionId: sessionId
            });
        } catch (error) {
            console.error('[set-language] Error:', error);
            res.status(400).json({
                success: false,
                error: error.message || 'Failed to set language'
            });
        }
    });



    // GET user's language preference
    app.get('/get-language/:sessionId', async (req, res) => {
        try {
            const { sessionId } = req.params;

            if (!sessionId) {
                return res.status(400).json({
                    success: false,
                    error: 'Session ID is required'
                });
            }

            // Since language is managed client-side, we return a success response
            // In production, you'd retrieve this from Redis/MongoDB
            res.json({
                success: true,
                language: null, // Client manages this
                hasLanguage: false,
                sessionId: sessionId,
                message: 'Language preference managed client-side'
            });
        } catch (error) {
            console.error('[get-language] Error:', error);
            res.status(500).json({
                success: false,
                error: error.message || 'Failed to get language'
            });
        }
    });



    // streaming responses with bilingual support
    app.post(
        '/chat-stream',
        async (req, res, next) => {
            // Rate limiting middleware
            if (!server._chatRateLimiter) {
                const redis = await server.dbManager.connectRedis().catch(() => null);
                server._chatRateLimiter = createRateLimiter({
                    redis,
                    windowSeconds: 60,
                    maxGlobal: 10,
                    maxPerSession: 2,
                    prefix: 'rl:chat:v1:',
                });
            }
            return server._chatRateLimiter(req, res, next);
        },

        async (req, res) => {
            const { question, sessionId: clientSessionId, language: clientLanguage } = req.body || {};

            if (!question || question.trim().length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Question is required and cannot be empty'
                });
            }

            const headerSessionId =
                typeof req.headers['x-session-id'] === 'string' ? req.headers['x-session-id'] : undefined;
            const sessionId =
                clientSessionId ||
                headerSessionId ||
                `anon-${Date.now()}-${Math.random().toString(16).slice(2)}`;

            // Get language from request (client sends it with each request)
            const userLanguage = clientLanguage || 'english';

            if (languageManager.isLanguageChangeRequest(question)) {
                console.log(`[chat-stream] Language change requested for session ${sessionId}`);

                return res.json({
                    success: true,
                    requiresLanguageSelection: true,
                    sessionId: sessionId,
                    message: getMessage('languageSelection', 'bilingual')
                });
            }

            if (!['english', 'hindi'].includes(userLanguage)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid language parameter. Must be "english" or "hindi"'
                });
            }

            const history = server.chatHistory ? await server.chatHistory.getHistory(sessionId) : [];

            const recordHistory = async (assistantText) => {
                if (!server.chatHistory) return;
                try {
                    await server.chatHistory.appendMessage(sessionId, {
                        role: 'user',
                        content: question,
                        at: new Date().toISOString(),
                    });
                    await server.chatHistory.appendMessage(sessionId, {
                        role: 'assistant',
                        content: assistantText || '',
                        at: new Date().toISOString(),
                    });
                } catch (historyError) {
                    console.warn('[ChatHistory] append failed:', historyError?.message || historyError);
                }
            };

            if (!server.isInitialized) {
                const errorMsg = getMessage('systemNotInitialized', userLanguage);
                return res.status(503).json({
                    success: false,
                    error: errorMsg,
                });
            }

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            if (typeof res.flushHeaders === 'function') {
                res.flushHeaders();
            }

            const send = (event, data) => {
                res.write(`event: ${event}\n`);
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };

            let _cacheVector = null;

            try {
                // Check response cache (skip cache if history exists to ensure context-aware responses)
                if (
                    history.length === 0 &&
                    server.responseCache &&
                    server.ragSystem?.embeddingCache &&
                    server.ragSystem?.embeddings
                ) {
                    const vector = await server.ragSystem.embeddingCache.getQueryEmbedding(
                        question,
                        async (q) => await server.ragSystem.embeddings.embedQuery(q)
                    );
                    _cacheVector = vector;
                    const result = await server.responseCache.getSimilar(vector);

                    if (result?.hit && result.item?.responseText) {
                        // Check if cached response is in the same language
                        const cachedLanguage = result.item.metadata?.language;

                        if (cachedLanguage === userLanguage) {
                            if (
                                typeof server.responseCache.isUsableHit === 'function' &&
                                server.responseCache.isUsableHit(result)
                            ) {
                                const meta = result.item.metadata || {};
                                console.log(
                                    `[ResponseCache] HIT sim=${result.similarity?.toFixed?.(
                                        4
                                    )} language=${userLanguage} → streaming cached answer`
                                );
                                send('chunk', { text: result.item.responseText });
                                send('end', {
                                    success: true,
                                    question,
                                    sources: meta.sources || [],
                                    relevantLinks: Array.isArray(meta.relevantLinks) ? meta.relevantLinks : [],
                                    confidence: meta.confidence,
                                    language: userLanguage,
                                    fromCache: true,
                                });
                                await recordHistory(result.item.responseText || '');
                                return res.end();
                            }
                        } else {
                            console.log(
                                `[ResponseCache] HIT skipped → language mismatch (cached: ${cachedLanguage}, requested: ${userLanguage})`
                            );
                        }
                    }
                } else if (history.length > 0) {
                    console.log('[ResponseCache] Skipping cache due to conversation history');
                }
            } catch (error) {
                console.warn('[ResponseCache] lookup (stream) failed:', error?.message || error);
            }

            try {
                console.log(`[chat-stream] Processing question in ${userLanguage} for session ${sessionId} (history: ${history.length} messages)`);

                const finalResponse = await server.ragSystem.chatStream(
                    question,
                    _cacheVector || null,
                    (chunkText) => {
                        if (chunkText) {
                            send('chunk', { text: chunkText });
                        }
                    },
                    history,
                    userLanguage
                );

                const { answerText, sources, relevantLinks, confidence } =
                    extractChatResponseFields(finalResponse);

                // Cache the response only if no history (to avoid caching context-dependent responses)
                try {
                    if (
                        history.length === 0 &&
                        server.responseCache &&
                        _cacheVector &&
                        answerText &&
                        sources.length > 0 &&
                        confidence !== null &&
                        confidence > 0
                    ) {
                        await server.responseCache.put(_cacheVector, {
                            responseText: answerText,
                            question,
                            metadata: {
                                sources,
                                relevantLinks,
                                confidence,
                                success: true,
                                language: userLanguage,
                                cachedAt: new Date().toISOString(),
                            },
                        });
                        console.log(`[ResponseCache] Cached response for language: ${userLanguage}`);
                    }
                } catch (cacheError) {
                    console.warn('[ResponseCache] put (stream) failed:', cacheError?.message || cacheError);
                }

                send('end', {
                    success: true,
                    question,
                    sources,
                    relevantLinks,
                    confidence: confidence ?? 0,
                    language: userLanguage,
                    usedHistory: history.length > 0,
                    historyLength: history.length,
                });
                await recordHistory(answerText || '');
                res.end();
            } catch (error) {
                console.error('chat-stream error:', error);
                const errorMsg = getMessage('error', userLanguage);
                send('error', {
                    error: error?.message || errorMsg,
                    language: userLanguage
                });
                res.end();
            }
        }
    );

}