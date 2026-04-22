// Theme management
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
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

// Global variables
let sqlWorker;
let currentBookDb;
let currentPage = 1;
let totalPages = 1;
let bookInfo = null;
let CONFIG = null;
let isDragging = false;

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
    
    currentPage = 1;
    document.getElementById('book-title-header').textContent = bookInfo.book_name;
    document.getElementById('book-title').textContent = bookInfo.book_name;
    document.getElementById('book-author-header').textContent = bookInfo.author_name || '';
    document.getElementById('book-author').textContent = bookInfo.author_name || '';
    document.getElementById('goto-input').max = totalPages;
    
    updatePageDisplay();
    updateProgressBar();
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
}

// Navigation functions
function nextPage(scrollToTop = true) {
    if (currentPage < totalPages) {
        currentPage++;
        updatePageDisplay();
        loadCurrentPage();
        if(scrollToTop)
            scrollToTop();
    }
}

function previousPage(scrollToTop = true) {
    if (currentPage > 1) {
        currentPage--;
        updatePageDisplay();
        loadCurrentPage();
        if(scrollToTop)
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
    window.location.href = 'index.html';
}

// Keyboard navigation
document.addEventListener('keydown', (e) => {
    switch(e.key) {
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