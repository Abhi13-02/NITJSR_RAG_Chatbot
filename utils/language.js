class LanguageManager {
    constructor() {}

    isLanguageChangeRequest(message) {
        if (!message || typeof message !== 'string') return false;

        const normalized = message.toLowerCase().trim();
        return (
            normalized === 'change-language' ||
            normalized === 'change language' ||
            normalized === 'bhasha badlo' ||
            normalized === 'भाषा बदलो' ||
            normalized === 'language change karo' ||
            normalized === '/language' ||
            normalized === '/lang'
        );
    }


    isValidLanguage(language) {
        return ['english', 'hindi'].includes(language?.toLowerCase());
    }


    normalizeLanguage(language) {
        const normalized = language?.toLowerCase();
        return this.isValidLanguage(normalized) ? normalized : 'english';
    }
}


export const languageManager = new LanguageManager();


export const BilingualMessages = {
    languageSelection: {
        english: 'Please select your preferred language:',
        hindi: 'कृपया अपनी पसंदीदा भाषा चुनें:',
        bilingual: `Please select your preferred language:
कृपया अपनी पसंदीदा भाषा चुनें:`,
    },

    languageChanged: {
        english: 'Language changed to English. How can I help you?',
        hindi: 'भाषा हिंदी में बदल गई। मैं आपकी कैसे मदद कर सकता हूं?',
    },

    error: {
        english: 'Sorry, I encountered an error. Please try again.',
        hindi: 'क्षमा करें, मुझे एक त्रुटि का सामना करना पड़ा। कृपया पुनः प्रयास करें।',
    },

    systemNotInitialized: {
        english: 'System is initializing. Please wait a moment.',
        hindi: 'सिस्टम प्रारंभ हो रहा है। कृपया एक क्षण प्रतीक्षा करें।',
    },

    noInformation: {
        english: "I don't have specific information about that topic. Could you please rephrase your question?",
        hindi: "मेरे पास उस विषय के बारे में विशिष्ट जानकारी नहीं है। क्या आप कृपया अपना प्रश्न दोबारा बता सकते हैं?",
    },

    invalidLanguage: {
        english: 'Invalid language selection. Please choose English or Hindi.',
        hindi: 'अमान्य भाषा चयन। कृपया अंग्रेजी या हिंदी चुनें।',
    },

    sessionRequired: {
        english: 'Session ID is required.',
        hindi: 'सत्र आईडी आवश्यक है।',
    },

    languageRequired: {
        english: 'Language parameter is required.',
        hindi: 'भाषा पैरामीटर आवश्यक है।',
    },
};



export function getMessage(messageKey, language = 'english', ...args) {
    const messages = BilingualMessages[messageKey];

    if (!messages) {
        console.warn(`[getMessage] Message key "${messageKey}" not found`);
        return '';
    }

    const normalizedLanguage = language?.toLowerCase() || 'english';
    const text = messages[normalizedLanguage] || messages.english || '';

    // Simple string interpolation if args provided
    if (args.length > 0) {
        return text.replace(/{(\d+)}/g, (match, index) => {
            const argIndex = parseInt(index, 10);
            return args[argIndex] !== undefined ? String(args[argIndex]) : match;
        });
    }

    return text;
}


// bilingual prompt instructions for AI
export function getLanguageInstruction(language) {
    const instructions = {
        english: 'IMPORTANT: Respond in English language only. Do not use Hindi or any other language.',
        hindi: 'महत्वपूर्ण: केवल हिंदी भाषा में उत्तर दें। अंग्रेजी या किसी अन्य भाषा का उपयोग न करें।',
    };

    return instructions[language?.toLowerCase()] || instructions.english;
}



export function getNoDocumentsFallback(language) {
    const fallbacks = {
        english: "I don't have specific information about that topic in the NIT Jamshedpur data. Could you please rephrase your question or ask about placements, academics, faculty, departments, or other college-related topics?",
        hindi: "मेरे पास एनआईटी जमशेदपुर डेटा में उस विषय के बारे में विशिष्ट जानकारी नहीं है। क्या आप कृपया अपना प्रश्न दोबारा बता सकते हैं या प्लेसमेंट, शिक्षा, संकाय, विभाग या अन्य कॉलेज से संबंधित विषयों के बारे में पूछ सकते हैं?",
    };

    return fallbacks[language?.toLowerCase()] || fallbacks.english;
}


export function validateLanguageParameter(language) {
    if (!language) {
        return {
            valid: false,
            language: 'english',
            error: 'Language parameter is missing',
        };
    }

    if (typeof language !== 'string') {
        return {
            valid: false,
            language: 'english',
            error: 'Language parameter must be a string',
        };
    }

    const normalized = language.toLowerCase().trim();

    if (!['english', 'hindi'].includes(normalized)) {
        return {
            valid: false,
            language: 'english',
            error: 'Language must be either "english" or "hindi"',
        };
    }

    return {
        valid: true,
        language: normalized,
        error: null,
    };
}