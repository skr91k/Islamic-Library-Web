// Theme management
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon();
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeIcon();
}

function updateThemeIcon() {
    const theme = document.documentElement.getAttribute('data-theme');
    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
        toggle.textContent = theme === 'dark' ? '☀️' : '🌙';
    }
}

// Initialize theme on page load
initTheme();

// AI Translation toggle
let aiTranslateEnabled = false;

function initAiTranslate() {
    aiTranslateEnabled = localStorage.getItem('aiTranslateEnabled') === 'true';
    updateAiTranslateButton();
}

function toggleAiTranslate() {
    aiTranslateEnabled = !aiTranslateEnabled;
    localStorage.setItem('aiTranslateEnabled', aiTranslateEnabled.toString());
    updateAiTranslateButton();

    // Trigger or hide translation based on new state
    if (aiTranslateEnabled) {
        scheduleTranslation();
    } else {
        hideTranslation();
    }
}

function updateAiTranslateButton() {
    const btn = document.getElementById('ai-translate-btn');
    if (btn) {
        if (aiTranslateEnabled) {
            btn.classList.add('enabled');
            btn.title = 'AI Translation: ON';
        } else {
            btn.classList.remove('enabled');
            btn.title = 'AI Translation: OFF';
        }
    }
}

// Initialize AI translate on page load
initAiTranslate();

// AI Translation Configuration
// API key loaded from config.js (falls back to empty string if not found)
const DEFAULT_API_KEY = (typeof CONFIG_API !== 'undefined' && CONFIG_API.GEMINI_API_KEY) || '';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
let translationTimeout = null;
let currentTranslationController = null;
let translationCache = null;
let prefetchTimeout = null;
let prefetchController = null;
let lastTranslatedPage = null;

// Translation Settings
const defaultSettings = {
    language: 'en',
    style: 'readable',
    model: 'gemini-flash-lite-latest',
    apiKey: ''
};

function getTranslationSettings() {
    const saved = localStorage.getItem('translationSettings');
    return saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
}

function saveTranslationSettings() {
    const settings = {
        language: document.getElementById('translation-language')?.value || 'en',
        style: document.getElementById('translation-style')?.value || 'readable',
        model: document.getElementById('translation-model')?.value || 'gemini-flash-lite-latest',
        apiKey: document.getElementById('user-api-key')?.value || ''
    };
    localStorage.setItem('translationSettings', JSON.stringify(settings));
}

let settingsBeforeOpen = null;

function loadTranslationSettings() {
    const settings = getTranslationSettings();
    const langEl = document.getElementById('translation-language');
    const styleEl = document.getElementById('translation-style');
    const modelEl = document.getElementById('translation-model');
    const apiKeyEl = document.getElementById('user-api-key');

    if (langEl) langEl.value = settings.language;
    if (styleEl) styleEl.value = settings.style;
    if (modelEl) modelEl.value = settings.model;
    if (apiKeyEl) apiKeyEl.value = settings.apiKey;

    updateCacheCount();
}

function openTranslationSettings() {
    // Store settings before opening to detect changes
    settingsBeforeOpen = JSON.stringify(getTranslationSettings());
    loadTranslationSettings();
    document.getElementById('translation-settings-modal')?.classList.remove('hidden');
}

function closeTranslationSettings() {
    document.getElementById('translation-settings-modal')?.classList.add('hidden');

    // Check if settings changed and re-translate if needed
    const currentSettings = JSON.stringify(getTranslationSettings());
    if (settingsBeforeOpen !== currentSettings && aiTranslateEnabled) {
        // Settings changed, re-translate current page
        scheduleTranslation();
    }
    settingsBeforeOpen = null;
}

// Close modal when clicking outside
document.addEventListener('click', (e) => {
    const modal = document.getElementById('translation-settings-modal');
    if (e.target === modal) {
        closeTranslationSettings();
    }
});

// Translation Cache using IndexedDB
async function initTranslationCache() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('TranslationCache', 1);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            translationCache = request.result;
            resolve(translationCache);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('translations')) {
                db.createObjectStore('translations', { keyPath: 'id' });
            }
        };
    });
}

function getCacheKey(bookId, pageNum, language) {
    return `${bookId}_${pageNum}_${language}`;
}

async function getCachedTranslation(bookId, pageNum, language) {
    if (!translationCache) await initTranslationCache();

    return new Promise((resolve) => {
        try {
            const tx = translationCache.transaction('translations', 'readonly');
            const store = tx.objectStore('translations');
            const key = getCacheKey(bookId, pageNum, language);
            const request = store.get(key);

            request.onsuccess = () => resolve(request.result?.text || null);
            request.onerror = () => resolve(null);
        } catch (e) {
            resolve(null);
        }
    });
}

async function setCachedTranslation(bookId, pageNum, language, text) {
    if (!translationCache) await initTranslationCache();

    return new Promise((resolve) => {
        try {
            const tx = translationCache.transaction('translations', 'readwrite');
            const store = tx.objectStore('translations');
            const key = getCacheKey(bookId, pageNum, language);
            store.put({ id: key, bookId, pageNum, language, text, timestamp: Date.now() });
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        } catch (e) {
            resolve(false);
        }
    });
}

async function clearTranslationCache() {
    if (!translationCache) await initTranslationCache();

    return new Promise((resolve) => {
        try {
            const tx = translationCache.transaction('translations', 'readwrite');
            const store = tx.objectStore('translations');
            store.clear();
            tx.oncomplete = () => {
                updateCacheCount();
                alert('Translation cache cleared successfully!');
                resolve(true);
            };
            tx.onerror = () => resolve(false);
        } catch (e) {
            resolve(false);
        }
    });
}

async function updateCacheCount() {
    if (!translationCache) {
        try {
            await initTranslationCache();
        } catch (e) {
            return;
        }
    }

    try {
        const tx = translationCache.transaction('translations', 'readonly');
        const store = tx.objectStore('translations');
        const request = store.count();

        request.onsuccess = () => {
            const countEl = document.getElementById('cache-count');
            if (countEl) countEl.textContent = request.result;
        };
    } catch (e) {
        console.error('Error counting cache:', e);
    }
}

// Language names for display
const languageNames = {
    // Popular
    en: 'English',
    ur: 'Urdu',
    tr: 'Turkish',
    // Indian Languages
    ml: 'Malayalam',
    hi: 'Hindi',
    bn: 'Bengali',
    ta: 'Tamil',
    te: 'Telugu',
    kn: 'Kannada',
    gu: 'Gujarati',
    mr: 'Marathi',
    pa: 'Punjabi',
    // Southeast Asian
    id: 'Indonesian',
    ms: 'Malay',
    // East Asian
    'zh-CN': 'Chinese (Simplified)',
    'zh-TW': 'Chinese (Traditional)',
    ja: 'Japanese',
    ko: 'Korean',
    // Central Asian
    uz: 'Uzbek',
    kk: 'Kazakh',
    tg: 'Tajik',
    ky: 'Kyrgyz',
    tk: 'Turkmen',
    // European
    ru: 'Russian',
    fr: 'French',
    de: 'German',
    es: 'Spanish',
    it: 'Italian',
    pt: 'Portuguese',
    nl: 'Dutch'
};

// Style prompts
const stylePrompts = {
    readable: 'Translate in an easy-to-read, flowing style that is accessible to general readers.',
    literal: 'Provide a literal, word-by-word translation that stays close to the original Arabic structure.',
    scholarly: 'Translate in an academic, scholarly style with precise terminology suitable for researchers.',
    simple: 'Translate using simple, basic vocabulary suitable for beginners and non-native speakers.'
};

function buildTranslationPrompt(arabicText, settings) {
    const langName = languageNames[settings.language] || 'English';
    const styleGuide = stylePrompts[settings.style] || stylePrompts.readable;

    return `You are a translator specializing in Islamic texts. Translate the following Arabic text to ${langName}.

${styleGuide}

Important guidelines:
- Preserve the religious meaning and context
- Keep Islamic terms like Allah, Quran, Hadith, etc. as transliterations when appropriate
- Only return the translation, no explanations or notes

Arabic text:
${arabicText}`;
}

async function translateWithGemini(arabicText) {
    // Cancel any pending translation
    if (currentTranslationController) {
        currentTranslationController.abort();
    }
    currentTranslationController = new AbortController();

    const settings = getTranslationSettings();
    const apiKey = settings.apiKey || DEFAULT_API_KEY;
    const model = settings.model || 'gemini-flash-lite-latest';
    const apiUrl = `${GEMINI_API_BASE}${model}:generateContent?key=${apiKey}`;

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: buildTranslationPrompt(arabicText, settings)
                    }]
                }],
                generationConfig: {
                    temperature: 0.3,
                    maxOutputTokens: 4096
                }
            }),
            signal: currentTranslationController.signal
        });

        if (response.status === 429) {
            return { error: 'quota_exceeded', details: `Status: ${response.status}` };
        }

        if (response.status === 400 || response.status === 403) {
            let errorDetails = `Status: ${response.status}`;
            try {
                const errorData = await response.json();
                errorDetails = errorData?.error?.message || errorDetails;
            } catch (e) { }
            return { error: 'api_key_invalid', details: errorDetails };
        }

        if (!response.ok) {
            let errorDetails = `Status: ${response.status} ${response.statusText}`;
            try {
                const errorData = await response.json();
                errorDetails = errorData?.error?.message || errorDetails;
            } catch (e) { }
            return { error: 'api_error', details: errorDetails };
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return { success: true, text };
    } catch (error) {
        if (error.name === 'AbortError') {
            return null; // Cancelled, not an error
        }
        console.error('Translation error:', error);
        return { error: 'network_error', details: error.message || 'Unknown error' };
    }
}

function scheduleTranslation() {
    // Clear any pending translation
    if (translationTimeout) {
        clearTimeout(translationTimeout);
    }

    // Cancel any pending prefetch
    if (prefetchTimeout) {
        clearTimeout(prefetchTimeout);
        prefetchTimeout = null;
    }
    if (prefetchController) {
        prefetchController.abort();
        prefetchController = null;
    }

    // Don't translate if disabled
    if (!aiTranslateEnabled) {
        hideTranslation();
        return;
    }

    // Show loading indicator
    showTranslationLoading();

    // Debounce: wait 1 second before translating
    translationTimeout = setTimeout(async () => {
        const pageContent = document.getElementById('page-content');
        const originalText = pageContent?.innerText || '';

        if (!originalText.trim()) {
            hideTranslation();
            return;
        }

        const settings = getTranslationSettings();
        const bookId = bookInfo?.book_id || 0;
        const pageNum = currentPage;
        const language = settings.language;

        // Check cache first
        const cachedTranslation = await getCachedTranslation(bookId, pageNum, language);
        if (cachedTranslation) {
            if (aiTranslateEnabled) {
                showTranslation(cachedTranslation, true); // true = from cache
                // Also schedule prefetch for next page
                lastTranslatedPage = pageNum;
                schedulePrefetch(pageNum);
            }
            return;
        }

        const result = await translateWithGemini(originalText);

        if (!result) {
            // Cancelled
            return;
        }

        if (!aiTranslateEnabled) {
            hideTranslation();
            return;
        }

        if (result.error) {
            showTranslationError(result.error, result.details);
        } else if (result.success) {
            // Save to cache
            await setCachedTranslation(bookId, pageNum, language, result.text);
            showTranslation(result.text, false);

            // Schedule prefetch for next page after 10 seconds
            lastTranslatedPage = pageNum;
            schedulePrefetch(pageNum);
        }
    }, 1000);
}

function showTranslationLoading() {
    let translationDiv = document.getElementById('translation-content');
    if (!translationDiv) {
        createTranslationContainer();
        translationDiv = document.getElementById('translation-content');
    }

    const settings = getTranslationSettings();
    const langName = languageNames[settings.language] || 'English';
    const headerEl = document.getElementById('translation-header-text');
    if (headerEl) {
        headerEl.innerHTML = `<img src="ai.png" alt="AI" style="width: 16px; height: 16px; vertical-align: middle;"> ${langName} Translation <span class="settings-icon">⚙️</span>`;
    }

    translationDiv.innerHTML = '<div class="translation-loading"><img src="ai.png" alt="AI" style="width: 16px; height: 16px; vertical-align: middle;"> Translating... <span class="translation-spinner"></span></div>';
    document.getElementById('translation-container').classList.remove('hidden');
}

function showTranslation(text, fromCache = false) {
    let translationDiv = document.getElementById('translation-content');
    if (!translationDiv) {
        createTranslationContainer();
        translationDiv = document.getElementById('translation-content');
    }

    // Update header with language and cache status
    const settings = getTranslationSettings();
    const langName = languageNames[settings.language] || 'English';
    const cacheIndicator = fromCache ? ' 💾' : '';
    const headerEl = document.getElementById('translation-header-text');
    if (headerEl) {
        headerEl.innerHTML = `<img src="ai.png" alt="AI" style="width: 16px; height: 16px; vertical-align: middle;"> ${langName} Translation${cacheIndicator} <span class="settings-icon">⚙️</span>`;
    }

    translationDiv.innerHTML = text.replace(/\n/g, '<br>');
    document.getElementById('translation-container').classList.remove('hidden');
    document.getElementById('original-header')?.classList.remove('hidden');
}

function hideTranslation() {
    const container = document.getElementById('translation-container');
    if (container) {
        container.classList.add('hidden');
    }
    const originalHeader = document.getElementById('original-header');
    if (originalHeader) {
        originalHeader.classList.add('hidden');
    }
    if (translationTimeout) {
        clearTimeout(translationTimeout);
    }
}

function showTranslationError(errorType, details = '') {
    let translationDiv = document.getElementById('translation-content');
    if (!translationDiv) {
        createTranslationContainer();
        translationDiv = document.getElementById('translation-content');
    }

    let errorMessage = '';
    let suggestion = '';

    switch (errorType) {
        case 'quota_exceeded':
            errorMessage = 'API quota exceeded | تجاوز حد الاستخدام';
            suggestion = 'Try changing the model, add your own API key, or wait and try again later.<br>جرب تغيير النموذج، أو إضافة مفتاح API الخاص بك، أو الانتظار والمحاولة لاحقاً.';
            break;
        case 'api_key_invalid':
            errorMessage = 'Invalid API key | مفتاح API غير صالح';
            suggestion = 'Please check your API key in settings.<br>يرجى التحقق من مفتاح API في الإعدادات.<br>Try changing the model, add your own API key, or wait and try again later.<br>جرب تغيير النموذج، أو إضافة مفتاح API الخاص بك، أو الانتظار والمحاولة لاحقاً.';
            break;
        case 'network_error':
            errorMessage = 'Network error | خطأ في الاتصال';
            suggestion = 'Please check your internet connection and try again.<br>يرجى التحقق من اتصالك بالإنترنت والمحاولة مرة أخرى.<br>Try changing the model, add your own API key, or wait and try again later.<br>جرب تغيير النموذج، أو إضافة مفتاح API الخاص بك، أو الانتظار والمحاولة لاحقاً.';
            break;
        default:
            errorMessage = 'Translation failed | فشلت الترجمة';
            suggestion = 'Try changing the API key or model in settings.<br>جرب تغيير مفتاح API أو النموذج في الإعدادات.';
    }

    const detailsHtml = details ? `<div class="error-details"><code>${details}</code></div>` : '';

    translationDiv.innerHTML = `
        <div class="translation-error">
            <div class="error-title">⚠️ ${errorMessage}</div>
            <div class="error-suggestion">${suggestion}</div>
            ${detailsHtml}
            <div class="error-buttons">
                <button class="error-retry-btn" onclick="retryTranslation()">
                    🔄 Retry | إعادة المحاولة
                </button>
                <button class="error-settings-btn" onclick="openTranslationSettings()">
                    ⚙️ Settings | الإعدادات
                </button>
            </div>
        </div>
    `;
    document.getElementById('translation-container').classList.remove('hidden');
    document.getElementById('original-header')?.classList.remove('hidden');
}

function retryTranslation() {
    if (aiTranslateEnabled) {
        scheduleTranslation();
    }
}

// Prefetch next page translation after successful translation
function schedulePrefetch(currentPageAtTranslation) {
    // Clear any pending prefetch
    if (prefetchTimeout) {
        clearTimeout(prefetchTimeout);
    }
    if (prefetchController) {
        prefetchController.abort();
        prefetchController = null;
    }

    // Wait 10 seconds before prefetching
    prefetchTimeout = setTimeout(async () => {
        // Check if user is still on the same page
        if (currentPage !== currentPageAtTranslation) {
            console.log('Prefetch cancelled: page changed');
            return;
        }

        // Check if there's a next page
        const nextPageNum = currentPageAtTranslation + 1;
        if (nextPageNum > totalPages) {
            console.log('Prefetch cancelled: no next page');
            return;
        }

        // Check if AI translate is still enabled
        if (!aiTranslateEnabled) {
            console.log('Prefetch cancelled: AI translate disabled');
            return;
        }

        const settings = getTranslationSettings();
        const bookId = bookInfo?.book_id || 0;
        const language = settings.language;

        // Check if next page translation is already cached
        const cachedTranslation = await getCachedTranslation(bookId, nextPageNum, language);
        if (cachedTranslation) {
            console.log('Prefetch skipped: next page already cached');
            return;
        }

        // Get next page content from database
        const nextPageContent = getPageContent(nextPageNum);
        if (!nextPageContent) {
            console.log('Prefetch cancelled: could not get next page content');
            return;
        }

        console.log('Prefetching translation for page', nextPageNum);

        // Create abort controller for prefetch
        prefetchController = new AbortController();

        // Translate next page (silently in background)
        const result = await translateWithGeminiPrefetch(nextPageContent, prefetchController.signal);

        // Check again if still on same page and AI enabled
        if (currentPage !== currentPageAtTranslation || !aiTranslateEnabled) {
            console.log('Prefetch result discarded: page changed or AI disabled');
            return;
        }

        if (result && result.success) {
            // Save to cache
            await setCachedTranslation(bookId, nextPageNum, language, result.text);
            console.log('Prefetch successful: page', nextPageNum, 'translation cached');
        } else if (result && result.error) {
            console.log('Prefetch failed:', result.error);
        }
    }, 10000); // 10 seconds delay
}

// Get page content by page number
function getPageContent(pageNum) {
    if (!currentBookDb) return null;

    try {
        const stmt = currentBookDb.prepare("SELECT * FROM page ORDER BY id LIMIT 1 OFFSET ?");
        stmt.bind([pageNum - 1]);

        if (stmt.step()) {
            const page = stmt.getAsObject();
            const content = page.content || '';
            stmt.free();
            // Strip HTML tags to get plain text for translation
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = content;
            return tempDiv.innerText || tempDiv.textContent || '';
        }
        stmt.free();
        return null;
    } catch (e) {
        console.error('Error getting page content:', e);
        return null;
    }
}

// Separate translate function for prefetch (doesn't cancel current translation)
async function translateWithGeminiPrefetch(arabicText, signal) {
    const settings = getTranslationSettings();
    const apiKey = settings.apiKey || DEFAULT_API_KEY;
    const model = settings.model || 'gemini-flash-lite-latest';
    const apiUrl = `${GEMINI_API_BASE}${model}:generateContent?key=${apiKey}`;

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: buildTranslationPrompt(arabicText, settings)
                    }]
                }],
                generationConfig: {
                    temperature: 0.3,
                    maxOutputTokens: 4096
                }
            }),
            signal: signal
        });

        if (!response.ok) {
            return { error: 'api_error', details: `Status: ${response.status}` };
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return { success: true, text };
    } catch (error) {
        if (error.name === 'AbortError') {
            return null; // Cancelled
        }
        return { error: 'network_error', details: error.message };
    }
}

function createTranslationContainer() {
    const pageContent = document.getElementById('page-content');
    if (!pageContent) return;

    const settings = getTranslationSettings();
    const langName = languageNames[settings.language] || 'English';

    // Create translation container
    const container = document.createElement('div');
    container.id = 'translation-container';
    container.className = 'translation-container hidden';
    container.innerHTML = `
        <div class="translation-header clickable" onclick="openTranslationSettings()" id="translation-header-text">
            <img src="ai.png" alt="AI" style="width: 16px; height: 16px; vertical-align: middle;"> ${langName} Translation <span class="settings-icon">⚙️</span>
        </div>
        <div id="translation-content" class="translation-content"></div>
    `;

    // Create original content header
    const originalHeader = document.createElement('div');
    originalHeader.id = 'original-header';
    originalHeader.className = 'original-header hidden';
    originalHeader.innerHTML = '📖 النص العربي الأصلي | Arabic Original';

    // Insert BEFORE page-content so translation shows first
    pageContent.parentNode.insertBefore(container, pageContent);
    pageContent.parentNode.insertBefore(originalHeader, pageContent);
}

// Global variables
let sqlWorker;
let currentBookDb;
let currentPage = 1;
let totalPages = 1;
let bookInfo = null;
let CONFIG = null;
let isDragging = false;
let bookTitles = []; // Array of {content, page} for subtitle display

// Reading progress management
function saveReadingProgress() {
    if (bookInfo && bookInfo.book_id) {
        localStorage.setItem(`reading_progress_${bookInfo.book_id}`, currentPage.toString());
    }
}

function getReadingProgress() {
    if (bookInfo && bookInfo.book_id) {
        const saved = localStorage.getItem(`reading_progress_${bookInfo.book_id}`);
        return saved ? parseInt(saved, 10) : 1;
    }
    return 1;
}

// Initialize the reader
async function init() {
    try {
        // Get book info from localStorage
        const storedBookInfo = localStorage.getItem('currentBook');
        if (!storedBookInfo) {
            window.location.href = "/";
            //showError('لم يتم العثور على معلومات الكتاب. يرجى العودة إلى القائمة الرئيسية.');
            return;
        }

        bookInfo = JSON.parse(storedBookInfo);
        CONFIG = bookInfo.config;

        // Initialize SQL.js
        const SQL = await initSqlJs({
            locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
        });
        sqlWorker = SQL;

        // Load the book
        await loadBook();

        // Initialize translation cache
        await initTranslationCache();

        hideLoading();
        showReader();
        initializeSeekBar();

    } catch (error) {
        showError('خطأ في تحميل الكتاب: ' + error.message);
        hideLoading();
    }
}

// Initialize seekable progress bar
function initializeSeekBar() {
    const progressBar = document.getElementById('progress-bar');
    const progressTooltip = document.getElementById('progress-tooltip');

    // Mouse events for desktop
    progressBar.addEventListener('mousedown', handleSeekStart);
    progressBar.addEventListener('mousemove', handleSeekMove);
    progressBar.addEventListener('mouseup', handleSeekEnd);
    progressBar.addEventListener('mouseleave', handleSeekEnd);

    // Touch events for mobile
    progressBar.addEventListener('touchstart', handleSeekStart);
    progressBar.addEventListener('touchmove', handleSeekMove);
    progressBar.addEventListener('touchend', handleSeekEnd);

    // Prevent default behaviors
    progressBar.addEventListener('dragstart', e => e.preventDefault());
}

function handleSeekStart(e) {
    isDragging = true;
    handleSeekMove(e);
    document.addEventListener('mousemove', handleSeekMove);
    document.addEventListener('mouseup', handleSeekEnd);
}

function handleSeekMove(e) {
    if (!isDragging && e.type !== 'mousemove') return;

    const progressBar = document.getElementById('progress-bar');
    const rect = progressBar.getBoundingClientRect();

    let clientX;
    if (e.touches) {
        clientX = e.touches[0].clientX;
    } else {
        clientX = e.clientX;
    }

    // Calculate position relative to the progress bar (RTL aware)
    const position = (rect.right - clientX) / rect.width;
    const clampedPosition = Math.max(0, Math.min(1, position));

    // Calculate target page
    const targetPage = Math.max(1, Math.min(totalPages, Math.round(clampedPosition * totalPages)));

    // Update tooltip
    const tooltip = document.getElementById('progress-tooltip');
    tooltip.textContent = `الصفحة ${targetPage}`;
    tooltip.style.left = `${(1 - clampedPosition) * 100}%`;

    // If actively dragging, update the visual progress
    if (isDragging) {
        const progressFill = document.getElementById('progress-fill');
        progressFill.style.width = `${clampedPosition * 100}%`;

        // Update page info temporarily
        updatePageDisplayElements(targetPage);
    }
}

function handleSeekEnd(e) {
    if (!isDragging) return;

    const progressBar = document.getElementById('progress-bar');
    const rect = progressBar.getBoundingClientRect();

    let clientX;
    if (e.changedTouches) {
        clientX = e.changedTouches[0].clientX;
    } else {
        clientX = e.clientX;
    }

    // Calculate final position (RTL aware)
    const position = (rect.right - clientX) / rect.width;
    const clampedPosition = Math.max(0, Math.min(1, position));

    // Calculate and navigate to target page
    const targetPage = Math.max(1, Math.min(totalPages, Math.round(clampedPosition * totalPages)));

    currentPage = targetPage;
    updatePageDisplay();
    loadCurrentPage();
    scrollToTop();

    isDragging = false;

    // Clean up event listeners
    document.removeEventListener('mousemove', handleSeekMove);
    document.removeEventListener('mouseup', handleSeekEnd);
}

// Cache management using IndexedDB
class CacheManager {
    constructor() {
        this.dbName = CONFIG?.dbName || 'booksCache';
        this.version = CONFIG?.version || 1;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('books')) {
                    db.createObjectStore('books', { keyPath: 'id' });
                }
            };
        });
    }

    async get(storeName, id) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(id);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    async set(storeName, data) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([storeName], 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.put(data);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }
}

let cacheManager;

// Download and extract zip file with progress
async function downloadAndExtractZip(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`خطأ في التحميل: ${response.status} - ${url}`);
    }

    const contentLength = response.headers.get('content-length');
    const total = parseInt(contentLength, 10);
    let loaded = 0;

    const reader = response.body.getReader();
    const chunks = [];

    while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        chunks.push(value);
        loaded += value.length;

        if (total) {
            const progress = Math.round((loaded / total) * 100);
            updateProgress(progress);
        }
    }

    const arrayBuffer = new Uint8Array(loaded);
    let position = 0;
    for (let chunk of chunks) {
        arrayBuffer.set(chunk, position);
        position += chunk.length;
    }

    updateProgress(100);
    updateLoadingText('جاري استخراج الملفات...');

    const zip = await JSZip.loadAsync(arrayBuffer);

    // Find the SQLite file (should be book_id-major_online-minor_online.sqlite)
    let sqliteFile = null;
    for (const [filename, file] of Object.entries(zip.files)) {
        if (filename.endsWith('.sqlite') || filename.endsWith('.db')) {
            sqliteFile = file;
            console.log('Found SQLite file:', filename); // Debug log
            break;
        }
    }

    if (!sqliteFile) {
        console.log('Available files in zip:', Object.keys(zip.files)); // Debug log
        throw new Error('لم يتم العثور على ملف قاعدة البيانات في الأرشيف');
    }

    const sqliteData = await sqliteFile.async('uint8array');
    return sqliteData;
}

// Update progress percentage
function updateProgress(percentage) {
    const progressText = document.getElementById('progress-text');
    if (progressText) {
        progressText.textContent = percentage + '%';
    }
}

// Load book
async function loadBook() {
    updateLoadingText(`جاري تحميل الكتاب: ${bookInfo.book_name}`);
    updateProgress(0);

    console.log('Book info received:', bookInfo); // Debug log

    cacheManager = new CacheManager();

    // Create book filename using the format: book_id-major_online-minor_online
    // Handle undefined values with fallbacks
    const bookId = bookInfo.book_id || 0;
    const majorOnline = bookInfo.major_online || 0;
    const minorOnline = bookInfo.minor_online || 0;
    const bookFilename = `${bookId}-${majorOnline}-${minorOnline}`;

    console.log('Constructed filename:', bookFilename); // Debug log

    // Check cache first
    let bookData;
    const cached = await cacheManager.get('books', bookFilename);

    if (cached) {
        console.log('Book found in cache'); // Debug log
        updateProgress(100);
        bookData = cached.data;
    } else {
        // Download book using the new URL format
        const bookUrl = `${CONFIG.bookUrlPrefix}${bookFilename}.sqlite.zip`;
        console.log('Downloading from:', bookUrl); // Debug log
        bookData = await downloadAndExtractZip(bookUrl);

        // Cache the book
        await cacheManager.set('books', {
            id: bookFilename,
            data: bookData,
            book_name: bookInfo.book_name
        });
        console.log('Book cached successfully'); // Debug log
    }

    // Load book database
    currentBookDb = new sqlWorker.Database(bookData);

    // Load pages
    await loadBookPages();
}

// Load book pages
async function loadBookPages() {
    updateLoadingText('جاري تحميل صفحات الكتاب...');
    updateProgress('');

    const stmt = currentBookDb.prepare("SELECT COUNT(*) as count FROM page ORDER BY id");
    stmt.step();
    totalPages = stmt.getAsObject().count;
    stmt.free();

    // Restore last read page or start at page 1
    const savedPage = getReadingProgress();
    currentPage = Math.min(savedPage, totalPages);
    document.getElementById('book-title-header').textContent = bookInfo.book_name;
    document.getElementById('book-author-header').textContent = bookInfo.author_name || '';
    document.getElementById('goto-input').max = totalPages;

    updatePageDisplay();
    updateProgressBar();
    loadCurrentPage();

    // Load titles for subtitle display (async, low priority)
    setTimeout(loadTitles, 100);
}

// Load titles table for subtitle display
function loadTitles() {
    try {
        const stmt = currentBookDb.prepare("SELECT content, page FROM title ORDER BY CAST(page AS INTEGER) ASC");
        bookTitles = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            bookTitles.push({ content: row.content, page: row.page });
        }
        stmt.free();
        updateSubtitle();
    } catch (e) {
        // Title table may not exist in some books
        bookTitles = [];
    }
}

// Get subtitle for current page
function updateSubtitle() {
    const subtitleEl = document.getElementById('nav-subtitle');
    if (!subtitleEl || bookTitles.length === 0) return;

    // Find the title where page <= currentPage (highest such page)
    let subtitle = '';
    for (let i = bookTitles.length - 1; i >= 0; i--) {
        if (bookTitles[i].page <= currentPage) {
            subtitle = bookTitles[i].content || '';
            break;
        }
    }
    subtitleEl.textContent = subtitle;
}

// Show table of contents modal
function showTableOfContents() {
    if (bookTitles.length === 0) return;

    const modal = document.getElementById('toc-modal');
    const tocList = document.getElementById('toc-list');

    // Build TOC list
    tocList.innerHTML = bookTitles.map((title, index) => {
        const isActive = (index === bookTitles.length - 1 || bookTitles[index + 1].page > currentPage) && title.page <= currentPage;
        return `<div class="toc-item ${isActive ? 'active' : ''}" onclick="goToTocPage(${title.page})">
            <span class="toc-item-title">${title.content}</span>
            <span class="toc-item-page">${title.page}</span>
        </div>`;
    }).join('');

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
}

// Close table of contents modal
function closeTableOfContents() {
    const modal = document.getElementById('toc-modal');
    modal.classList.add('hidden');
    modal.style.display = 'none';
}

// Navigate to TOC page
function goToTocPage(page) {
    closeTableOfContents();
    currentPage = page;
    updatePageDisplay();
    loadCurrentPage();
}

// Load current page content
function loadCurrentPage() {
    const stmt = currentBookDb.prepare("SELECT * FROM page ORDER BY id LIMIT 1 OFFSET ?");
    stmt.bind([currentPage - 1]);

    if (stmt.step()) {
        const page = stmt.getAsObject();
        let content = page.content || 'لا يوجد محتوى لهذه الصفحة';

        // Clean HTML tags for better display but preserve some formatting
        // content = content.replace(/<span[^>]*>/g, '').replace(/<\/span>/g, '');
        //content = content.replace(/<[^>]*>/g, '').trim();

        document.getElementById('page-content').innerHTML = content;
    } else {
        document.getElementById('page-content').textContent = 'خطأ في تحميل الصفحة';
    }

    stmt.free();
    updateNavigationButtons();
    updateProgressBar();

    // Schedule AI translation (debounced)
    scheduleTranslation();

    // Update subtitle (low priority, after content loaded)
    updateSubtitle();
}

// Navigation functions
function nextPage(scrollToTop = true) {
    if (currentPage < totalPages) {
        currentPage++;
        updatePageDisplay();
        loadCurrentPage();
        if (scrollToTop)
            scrollToTop();
    }
}

function previousPage(scrollToTop = true) {
    if (currentPage > 1) {
        currentPage--;
        updatePageDisplay();
        loadCurrentPage();
        if (scrollToTop)
            scrollToTop();
    }
}

function goToPage() {
    const pageInput = document.getElementById('goto-input');
    const targetPage = parseInt(pageInput.value);

    if (targetPage >= 1 && targetPage <= totalPages) {
        currentPage = targetPage;
        updatePageDisplay();
        loadCurrentPage();
        scrollToTop();
        pageInput.value = '';
    } else {
        showError(`رقم الصفحة يجب أن يكون بين 1 و ${totalPages}`);
        setTimeout(() => hideError(), 3000);
    }
}

// Helper function to update all page display elements
function updatePageDisplayElements(pageNumber) {
    // Update both top and bottom navigation
    document.getElementById('current-page').textContent = pageNumber;
    document.getElementById('current-page-top').textContent = pageNumber;
    document.getElementById('current-page-info').textContent = pageNumber;
}

function updatePageDisplay() {
    updatePageDisplayElements(currentPage);

    // Update total pages
    document.getElementById('total-pages').textContent = totalPages;
    document.getElementById('total-pages-top').textContent = totalPages;
    document.getElementById('total-pages-info').textContent = totalPages;

    // Save reading progress
    saveReadingProgress();
}

function updateProgressBar() {
    const progress = (currentPage / totalPages) * 100;
    const progressFill = document.getElementById('progress-fill');
    progressFill.style.width = progress + '%';
}

function updateNavigationButtons() {
    // Update both top and bottom navigation buttons
    const prevBtnTop = document.getElementById('prev-btn-top');
    const nextBtnTop = document.getElementById('next-btn-top');
    const prevBtnBottom = document.getElementById('prev-btn');
    const nextBtnBottom = document.getElementById('next-btn');

    const isFirstPage = currentPage <= 1;
    const isLastPage = currentPage >= totalPages;

    // Disable/enable previous buttons
    prevBtnTop.disabled = isFirstPage;
    prevBtnBottom.disabled = isFirstPage;

    // Disable/enable next buttons
    nextBtnTop.disabled = isLastPage;
    nextBtnBottom.disabled = isLastPage;
}

function scrollToTop() {
    document.getElementById('page-content').scrollTop = 0;
    window.scrollTo(0, 0);
}

// Navigation functions
function goBack() {
    window.history.back();
}

function goHome() {
    window.location.href = 'home.html';
}

function filterByAuthor() {
    if (bookInfo && bookInfo.main_author) {
        window.location.href = `home.html?author=${bookInfo.main_author}`;
    }
}

// Keyboard navigation
document.addEventListener('keydown', (e) => {
    switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
            e.preventDefault();
            nextPage();
            break;
        case 'ArrowRight':
        case 'ArrowDown':
            e.preventDefault();
            previousPage();
            break;
        case 'Home':
            e.preventDefault();
            currentPage = 1;
            updatePageDisplay();
            loadCurrentPage();
            scrollToTop();
            break;
        case 'End':
            e.preventDefault();
            currentPage = totalPages;
            updatePageDisplay();
            loadCurrentPage();
            scrollToTop();
            break;
    }
});

// Handle Enter key in goto input
document.addEventListener('DOMContentLoaded', () => {
    const gotoInput = document.getElementById('goto-input');
    if (gotoInput) {
        gotoInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                goToPage();
            }
        });
    }
});

// UI helper functions
function hideLoading() {
    document.getElementById('loading').classList.add('hidden');
}

function showReader() {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('book-reader').classList.remove('hidden');
    document.getElementById('book-info').classList.remove('hidden');
    document.getElementById('page-controls').classList.remove('hidden');
    document.getElementById('error-message').classList.add('hidden');
}

function showError(message) {
    document.getElementById('error-message').textContent = message;
    document.getElementById('error-message').classList.remove('hidden');
}

function hideError() {
    document.getElementById('error-message').classList.add('hidden');
}

function updateLoadingText(text) {
    const loadingElement = document.querySelector('#loading p');
    if (loadingElement) {
        loadingElement.textContent = text;
    }
}

// Initialize when page loads
window.addEventListener('load', init);

// AI Translation Welcome Dialog
function showWelcomeDialog() {
    // Check if user has dismissed the dialog before
    const dontShowAgain = localStorage.getItem('aiWelcomeDismissed');
    if (dontShowAgain === 'true') {
        return;
    }

    // Show the dialog
    const dialog = document.getElementById('ai-welcome-dialog');
    if (dialog) {
        dialog.classList.remove('hidden');
    }
}

function closeWelcomeDialog() {
    const dialog = document.getElementById('ai-welcome-dialog');
    const checkbox = document.getElementById('dont-show-again');

    // Save preference if checkbox is checked
    if (checkbox && checkbox.checked) {
        localStorage.setItem('aiWelcomeDismissed', 'true');
    }

    // Hide the dialog
    if (dialog) {
        dialog.classList.add('hidden');
    }
}

// Show welcome dialog after page loads
window.addEventListener('load', () => {
    // Delay slightly to let the page render first
    setTimeout(showWelcomeDialog, 500);
});