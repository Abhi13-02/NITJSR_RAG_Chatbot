import { createRateLimiter } from '../rate-limiting/rateLimiter.js';


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
    app.post('/chat-stream',

        async (req, res, next) => {
            // lazy create limiter middleware
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
            const { question, sessionId: clientSessionId } = req.body || {};

            if (!question || question.trim().length === 0) {
                return res
                    .status(400)
                    .json({ success: false, error: 'Question is required and cannot be empty' });
            }

            const headerSessionId = typeof req.headers['x-session-id'] === 'string' ? req.headers['x-session-id'] : undefined;
            const sessionId =
                clientSessionId ||
                headerSessionId ||
                `anon-${Date.now()}-${Math.random().toString(16).slice(2)}`;

            const history = server.chatHistory
                ? await server.chatHistory.getHistory(sessionId)
                : [];
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
                return res.status(503).json({
                    success: false,
                    error: 'System not initialized. Please call /initialize first.',
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
                if (
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
                        if (typeof server.responseCache.isUsableHit === 'function' && server.responseCache.isUsableHit(result)) {
                            const meta = result.item.metadata || {};
                            console.log(
                                `[ResponseCache] HIT sim=${result.similarity?.toFixed?.(4)} → streaming cached answer`
                            );
                            send('chunk', { text: result.item.responseText });
                            send('end', {
                                success: true,
                                question,
                                sources: meta.sources || [],
                                relevantLinks: Array.isArray(meta.relevantLinks) ? meta.relevantLinks : [],
                                confidence: meta.confidence,
                            });
                            await recordHistory(result.item.responseText || '');
                            return res.end();
                        }

                        console.log('[ResponseCache] HIT skipped → metadata rejected, falling back to live generation');
                    }
                }
            } catch (error) {
                console.warn('[ResponseCache] lookup (stream) failed:', error?.message || error);
            }

            try {
                const finalResponse = await server.ragSystem.chatStream(
                    question,
                    _cacheVector || null,
                    (chunkText) => {
                        if (chunkText) {
                            send('chunk', { text: chunkText });
                        }
                    },
                    history
                );

                const { answerText, sources, relevantLinks, confidence } = extractChatResponseFields(finalResponse);

                try {
                    if (
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
                            },
                        });
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
                });
                await recordHistory(answerText || '');
                res.end();

            } catch (error) {
                console.error('chat-stream error:', error);
                send('error', { error: error?.message || 'Failed to stream response' });
                res.end();
            }
        }
    );

}