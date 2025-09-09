document.addEventListener('DOMContentLoaded', () => {
    // --- Twitch API 設定 ---
        const CLIENT_ID = 'wmrs4m3hc29v2n7mh1dt20cswv30wu';
    const REDIRECT_URI = window.location.origin + window.location.pathname;
    const AUTH_SCOPE = 'user:read:follows';

    // --- DOM要素 ---
    const loginContainer = document.getElementById('login-container');
    const appContainer = document.getElementById('app-container');
    const loginBtn = document.getElementById('login-btn');
    const streamerInput = document.getElementById('streamer-input');
    const addStreamerBtn = document.getElementById('add-streamer-btn');
    const streamerListDiv = document.getElementById('streamer-list');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const currentDisplay = document.getElementById('current-display');
    const suggestionsContainer = document.getElementById('suggestions-container');
    const zoomContainer = document.getElementById('zoom-container');
    const guestBtn = document.getElementById('guest-btn');

    // --- アプリケーションの状態 ---
    let accessToken = '';
    let streamers = [];
    let streamerDataCache = {};
    let vodCache = {};
    let loggedInUser = null;

    // --- UIの状態 ---
    let currentZoomLevel = 'time';
    let displayDate = new Date();
    let isAnimating = false;

    // --- 1. 認証と初期化 ---
    function handleAuthentication() {
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);
        if (params.has('access_token')) {
            accessToken = params.get('access_token');
            window.location.hash = '';
            if (loginContainer) loginContainer.classList.add('hidden');
            if (appContainer) appContainer.classList.remove('hidden');
            initializeAppLogic(false); // Logged in
        } else {
            const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=token&scope=${AUTH_SCOPE}`;
            if (loginBtn) loginBtn.href = authUrl;

            if (guestBtn) {
                guestBtn.addEventListener('click', () => {
                    if (loginContainer) loginContainer.classList.add('hidden');
                    if (appContainer) appContainer.classList.remove('hidden');
                    initializeAppLogic(true); // Guest mode
                }, { once: true });
            }
        }
    }

    async function initializeAppLogic(isGuest = false) {
        setupEventListeners();
        updateNavControls();

        zoomContainer.innerHTML = '<div class="loading">Loading...</div>';

        if (isGuest) {
            streamers = [];
            await updateStreamerList();
        } else {
            loggedInUser = await getLoggedInUser();
            if (loggedInUser) {
                streamers = await fetchFollowedChannels(loggedInUser.id);
                await updateStreamerList();
            }
        }
        
        // 初期ビューを描画
        await render();
    }

    function setupEventListeners() {
        if (addStreamerBtn) addStreamerBtn.addEventListener('click', () => handleAddStreamer(streamerInput.value));
        if (streamerInput) {
            streamerInput.addEventListener('keypress', e => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddStreamer(streamerInput.value);
                    hideSuggestions();
                }
            });
            streamerInput.addEventListener('input', debounce(handleSuggestionSearch, 300));
        }
        if (streamerListDiv) streamerListDiv.addEventListener('click', handleRemoveStreamer);
        if (prevBtn) prevBtn.addEventListener('click', handlePrevClick);
        if (nextBtn) nextBtn.addEventListener('click', handleNextClick);
        if (currentDisplay) currentDisplay.addEventListener('click', handleZoomOut);
        if (zoomContainer) zoomContainer.addEventListener('click', handleZoomIn);
        if (suggestionsContainer) suggestionsContainer.addEventListener('click', handleSuggestionClick);
        
        document.addEventListener('click', (e) => {
            if (streamerInput && !e.target.closest('.streamer-input-container')) {
                hideSuggestions();
            }
        });
    }

    // --- 2. API通信 ---
    async function twitchApiFetch(endpoint, pagination = false) {
        // If in guest mode (no access token), use our backend proxy.
        if (!accessToken) {
            try {
                const response = await fetch('./api/twitch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ endpoint })
                });
                if (!response.ok) {
                    throw new Error(`Backend proxy request failed: ${response.status}`);
                }
                const data = await response.json();
                // The proxy returns the entire Twitch response, which includes the 'data' array.
                return data.data || []; 
            } catch (error) {
                console.error('Backend proxy fetch error:', error);
                alert('チャンネル情報の取得中にエラーが発生しました。バックエンドが正しく構成されていない可能性があります。');
                return null;
            }
        }

        // If logged in, make direct calls to Twitch API.
        let allData = [];
        let cursor = null;
        const baseUrl = `https://api.twitch.tv/helix/${endpoint}`;
        const fetchPage = async (url) => {
            try {
                const headers = { 'Client-Id': CLIENT_ID, 'Authorization': `Bearer ${accessToken}` };
                const response = await fetch(url, { headers });

                if (response.status === 401) { 
                    alert('認証が切れました。再度ログインしてください。'); 
                    window.location.hash = ''; 
                    handleAuthentication(); 
                    return null; 
                }
                if (!response.ok) throw new Error(`API request failed: ${response.status}`);
                return await response.json();
            } catch (error) { console.error('Twitch API fetch error:', error); return null; }
        };
        let url = baseUrl;
        let data = await fetchPage(url);
        if (data && data.data) allData.push(...data.data);
        if (pagination) {
            while (data && data.pagination && data.pagination.cursor) {
                cursor = data.pagination.cursor;
                const separator = baseUrl.includes('?') ? '&' : '?';
                url = `${baseUrl}${separator}after=${cursor}`;
                data = await fetchPage(url);
                if (data && data.data) allData.push(...data.data);
            }
        }
        return allData;
    }

    async function getLoggedInUser() {
        const result = await twitchApiFetch('users');
        return result && result.length > 0 ? result[0] : null;
    }

    async function fetchFollowedChannels(userId) {
        const followed = await twitchApiFetch(`channels/followed?user_id=${userId}`, true);
        if (followed) {
            followed.forEach(f => { streamerDataCache[f.broadcaster_login] = { id: f.broadcaster_id, display_name: f.broadcaster_name, login: f.broadcaster_login }; });
            return followed.map(f => f.broadcaster_login);
        }
        return [];
    }

    async function getStreamerData(loginName) {
        if (streamerDataCache[loginName]) return streamerDataCache[loginName];
        const users = await twitchApiFetch(`users?login=${loginName}`);
        if (users && users.length > 0) { const userData = users[0]; streamerDataCache[loginName] = { id: userData.id, display_name: userData.display_name, login: userData.login }; return streamerDataCache[loginName]; }
        return null;
    }

    async function fetchVodsForStreamers(year) {
        const cacheKey = `vods-${year}`;
        if (vodCache[cacheKey]) return vodCache[cacheKey];
        const vodsByStreamer = {};
        const promises = streamers.map(async (login) => {
            const streamerData = await getStreamerData(login);
            if (!streamerData) return;
            const vods = await twitchApiFetch(`videos?user_id=${streamerData.id}&first=100&type=archive`, true);
            if (vods) {
                const filteredVods = vods.filter(vod => new Date(vod.created_at).getFullYear() === year);
                vodsByStreamer[login] = filteredVods;
            }
        });
        await Promise.all(promises);
        vodCache[cacheKey] = vodsByStreamer;
        return vodsByStreamer;
    }

    async function fetchChannelSuggestions(query) {
        if (!query) return [];
        const data = await twitchApiFetch(`search/channels?query=${encodeURIComponent(query)}&first=5`);
        return data || [];
    }

    // --- 3. レンダリングロジック ---
    async function render(skipAnimation = false) {
        updateNavControls();
        if (!zoomContainer) return;

        const renderContent = async () => {
            let newContent = '';
            switch (currentZoomLevel) {
                case 'year': newContent = await getYearViewHtml(); break;
                case 'month': newContent = await getMonthViewHtml(); break;
                case 'day': newContent = await getDayGridViewHtml(); break;
                case 'time': newContent = await getTimeViewHtml(); break;
            }
            zoomContainer.innerHTML = newContent;

            const newView = zoomContainer.querySelector('.zoom-view');
            if (newView && !skipAnimation) {
                requestAnimationFrame(() => {
                    newView.classList.remove('is-zooming-in');
                });
            }
        };

        const currentView = zoomContainer.querySelector('.zoom-view');
        if (currentView && !skipAnimation && isAnimating) {
            currentView.classList.add('is-zooming-out');
            currentView.addEventListener('transitionend', () => {
                renderContent();
                isAnimating = false;
            }, { once: true });
        } else {
            renderContent();
        }
    }

    function updateNavControls() {
        if (!currentDisplay || !prevBtn || !nextBtn) return;
        
        currentDisplay.classList.toggle('clickable', currentZoomLevel !== 'year');
        prevBtn.style.visibility = 'visible';
        nextBtn.style.visibility = 'visible';

        switch (currentZoomLevel) {
            case 'year': 
                currentDisplay.textContent = 'Timeline'; 
                prevBtn.style.visibility = 'hidden'; 
                nextBtn.style.visibility = 'hidden'; 
                break;
            case 'month': 
                currentDisplay.textContent = `${displayDate.getFullYear()}`;
                break;
            case 'day': 
                currentDisplay.textContent = `${displayDate.getFullYear()}年 ${displayDate.getMonth() + 1}月`; 
                break;
            case 'time': 
                currentDisplay.textContent = `${displayDate.getFullYear()}年 ${displayDate.getMonth() + 1}月 ${displayDate.getDate()}日`; 
                break;
        }
    }

    async function getYearViewHtml() {
        const currentYear = new Date().getFullYear();
        const years = Array.from({ length: 5 }, (_, i) => currentYear - i);
        let html = '<div class="grid-container year-grid zoom-view is-zooming-in">';
        for (const year of years) { html += `<div class="grid-item year-item" data-year="${year}"><h2>${year}</h2></div>`; }
        html += '</div>';
        return html;
    }

    async function getMonthViewHtml() {
        const year = displayDate.getFullYear();
        const vodsByStreamer = await fetchVodsForStreamers(year);
        const activityByMonth = Array(12).fill(0);
        Object.values(vodsByStreamer).flat().forEach(vod => { activityByMonth[new Date(vod.created_at).getMonth()]++; });
        const months = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
        let html = '<div class="grid-container month-grid zoom-view is-zooming-in">';
        months.forEach((month, index) => { html += `<div class="grid-item month-item ${activityByMonth[index] > 0 ? 'has-activity' : ''}" data-month="${index}">${month}</div>`; });
        html += '</div>';
        return html;
    }

    async function getDayGridViewHtml() {
        const year = displayDate.getFullYear();
        const month = displayDate.getMonth();
        const vodsByStreamer = await fetchVodsForStreamers(year);
        const activityByDay = {};
        Object.values(vodsByStreamer).flat().forEach(vod => { const d = new Date(vod.created_at); if (d.getMonth() === month) { if (!activityByDay[d.getDate()]) activityByDay[d.getDate()] = 0; activityByDay[d.getDate()]++; } });
        let html = '<div class="grid-container day-grid zoom-view is-zooming-in">';
        ['日', '月', '火', '水', '木', '金', '土'].forEach(day => { html += `<div class="day-header">${day}</div>`; });
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const firstDayOfWeek = new Date(year, month, 1).getDay();
        for (let i = 0; i < firstDayOfWeek; i++) html += '<div class="grid-item day-item empty"></div>';
        for (let i = 1; i <= daysInMonth; i++) { html += `<div class="grid-item day-item ${activityByDay[i] > 0 ? 'has-activity' : ''}" data-day="${i}"><span class="day-number">${i}</span></div>`; }
        html += '</div>';
        return html;
    }

    async function getTimeViewHtml() {
        if (streamers.length === 0) {
            return '<div class="zoom-view"><p style="text-align: center; padding: 2rem;">フォロー中のチャンネルがないか、まだ誰も配信していません。<br>上の入力欄からチャンネルを追加してください。</p></div>'
        }

        const year = displayDate.getFullYear();
        const vodsByStreamer = await fetchVodsForStreamers(year);
        const dayVodsByStreamer = {};
        streamers.forEach(login => {
            const streamerVods = vodsByStreamer[login] || [];
            dayVodsByStreamer[login] = streamerVods.filter(vod => { const d = new Date(vod.created_at); return d.getMonth() === displayDate.getMonth() && d.getDate() === displayDate.getDate(); });
        });

        let streamerRows = '';
        if (streamers.length > 0) {
            const liveStatusSet = new Set((await twitchApiFetch(`streams?${streamers.map(n => `user_login=${n}`).join('&')}`)).map(s => s.user_login));
            
            const sortedStreamers = [...streamers].sort((a, b) => {
                const aIsLive = liveStatusSet.has(a);
                const bIsLive = liveStatusSet.has(b);
                if (aIsLive === bIsLive) return 0;
                return bIsLive - aIsLive;
            });

            sortedStreamers.forEach(login => {
                const streamerData = streamerDataCache[login];
                if (!streamerData) return;
                const isLive = liveStatusSet.has(login);
                let broadcastBlocks = '';
                if (dayVodsByStreamer[login]) {
                    dayVodsByStreamer[login].forEach(vod => { broadcastBlocks += createBroadcastBlockHtml(vod); });
                }
                streamerRows += `
                    <div class="timeline-row">
                        <div class="streamer-name">
                            ${isLive ? '<div class="live-indicator"></div>' : ''}
                            <a href="https://www.twitch.tv/${login}" target="_blank" title="${streamerData.display_name}">${streamerData.display_name}</a>
                        </div>
                        <div class="timeline-track">${broadcastBlocks}</div>
                    </div>`;
            });
        }

        let timeMarkers = '';
        for (let i = 0; i < 24; i += 3) { timeMarkers += `<span>${i}:00</span>`; }

        return `
            <div class="time-view-container zoom-view is-zooming-in">
                <div id="timeline-header">
                    <div class="time-markers-corner"></div>
                    <div class="time-markers">${timeMarkers}</div>
                </div>
                <div id="timeline-body">${streamerRows}</div>
            </div>`;
    }

    function createBroadcastBlockHtml(vod) {
        const startTime = new Date(vod.created_at);
        const endTime = new Date(startTime.getTime() + parseTwitchDuration(vod.duration));
        const startOfDay = new Date(displayDate).setHours(0, 0, 0, 0);
        const totalDaySeconds = 24 * 60 * 60;
        const startSeconds = (startTime - startOfDay) / 1000;
        const endSeconds = (endTime - startOfDay) / 1000;
        const left = Math.max(0, (startSeconds / totalDaySeconds) * 100);
        const width = (Math.min(endSeconds, totalDaySeconds) - Math.max(startSeconds, 0)) / totalDaySeconds * 100;
        return `<a href="${vod.url}" target="_blank" class="broadcast-block" style="left: ${left}%; width: ${width}%;" title="${vod.title}
${startTime.toLocaleString()}
${vod.duration}"><div class="broadcast-title-text">${vod.title}</div></a>`;
    }

    // --- 4. ナビゲーションとUI操作 ---
    function handlePrevClick() { if (isAnimating) return; isAnimating = true; if (currentZoomLevel === 'month') displayDate.setFullYear(displayDate.getFullYear() - 1); if (currentZoomLevel === 'day') displayDate.setMonth(displayDate.getMonth() - 1); if (currentZoomLevel === 'time') displayDate.setDate(displayDate.getDate() - 1); render(); }
    function handleNextClick() { if (isAnimating) return; isAnimating = true; if (currentZoomLevel === 'month') displayDate.setFullYear(displayDate.getFullYear() + 1); if (currentZoomLevel === 'day') displayDate.setMonth(displayDate.getMonth() + 1); if (currentZoomLevel === 'time') displayDate.setDate(displayDate.getDate() + 1); render(); }

    function handleZoomIn(e) {
        if (isAnimating) return;
        const target = e.target.closest('.grid-item');
        if (!target || target.classList.contains('empty')) return;
        isAnimating = true;
        if (currentZoomLevel === 'year') { displayDate.setFullYear(parseInt(target.dataset.year)); currentZoomLevel = 'month'; }
        else if (currentZoomLevel === 'month') { displayDate.setMonth(parseInt(target.dataset.month)); currentZoomLevel = 'day'; }
        else if (currentZoomLevel === 'day') { displayDate.setDate(parseInt(target.dataset.day)); currentZoomLevel = 'time'; }
        else { isAnimating = false; return; }
        render();
    }

    function handleZoomOut() {
        if (isAnimating || currentZoomLevel === 'year') return;
        isAnimating = true;
        if (currentZoomLevel === 'month') currentZoomLevel = 'year';
        else if (currentZoomLevel === 'day') currentZoomLevel = 'month';
        else if (currentZoomLevel === 'time') currentZoomLevel = 'day';
        render();
    }

    async function handleAddStreamer(name) {
        const loginName = name.trim().toLowerCase();
        if (loginName && !streamers.includes(loginName)) {
            const data = await getStreamerData(loginName);
            if (data) {
                streamers.push(loginName);
                vodCache = {};
                await updateStreamerList();
                await render();
            } else {
                alert('存在しないチャンネル名です。');
            }
        }
        if(streamerInput) streamerInput.value = '';
        hideSuggestions();
    }

    async function handleRemoveStreamer(e) {
        if (e.target.classList.contains('remove-streamer-btn')) {
            const name = e.target.dataset.streamer;
            streamers = streamers.filter(s => s !== name);
            vodCache = {};
            await updateStreamerList();
            await render();
        }
    }

    async function updateStreamerList() {
        if (!streamerListDiv) return;
        streamerListDiv.innerHTML = '';
        for (const loginName of streamers) {
            const streamerData = await getStreamerData(loginName);
            const displayName = streamerData ? streamerData.display_name : loginName;
            const tag = document.createElement('div');
            tag.className = 'streamer-tag';
            tag.innerHTML = `<span>${displayName}</span><button class="remove-streamer-btn" data-streamer="${loginName}">&times;</button>`;
            streamerListDiv.appendChild(tag);
        }
    }

    async function handleSuggestionSearch() {
        if (!streamerInput) return;
        const query = streamerInput.value.trim();
        if (query.length < 2) { hideSuggestions(); return; }
        const suggestions = await fetchChannelSuggestions(query);
        if (suggestionsContainer && suggestions.length > 0) {
            suggestionsContainer.classList.remove('hidden');
            suggestionsContainer.innerHTML = suggestions.map(channel => `
                <div class="suggestion-item" data-login="${channel.broadcaster_login}">
                    <img src="${channel.thumbnail_url.replace('{width}x{height}', '50x50')}" alt="">
                    <span>${channel.display_name} (${channel.broadcaster_login})</span>
                </div>
            `).join('');
        } else {
            hideSuggestions();
        }
    }

    function handleSuggestionClick(e) {
        const item = e.target.closest('.suggestion-item');
        if (item) {
            const login = item.dataset.login;
            handleAddStreamer(login);
        }
    }

    function hideSuggestions() {
        if(suggestionsContainer) suggestionsContainer.classList.add('hidden');
    }

    function parseTwitchDuration(duration) {
        let seconds = 0;
        const hoursMatch = duration.match(/(\d+)h/);
        const minutesMatch = duration.match(/(\d+)m/);
        const secondsMatch = duration.match(/(\d+)s/);
        if (hoursMatch) seconds += parseInt(hoursMatch[1]) * 3600;
        if (minutesMatch) seconds += parseInt(minutesMatch[1]) * 60;
        if (secondsMatch) seconds += parseInt(secondsMatch[1]);
        return seconds * 1000;
    }

    function debounce(func, delay) {
        let timeout;
        return function(...args) {
            const context = this;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(context, args), delay);
        };
    }

    // --- Affiliate Link Randomizer ---
    function setupAffiliateLink() {
        const keywords = [
            'ゲーミングキーボード',
            'ゲーミングマウス',
            'ゲーミングモニター',
            'ゲーミングヘッドセット',
            'ゲーミングPC',
            'ゲーミングコントローラー'
        ];
        // ★★★ ご自身のAmazonアソシエイトタグに書き換えてください ★★★
        const affiliateTag = 'rmiyazaki12-22'; 

        const linkElement = document.getElementById('affiliate-link');
        if (!linkElement) return;

        const randomKeyword = keywords[Math.floor(Math.random() * keywords.length)];
        
        const encodedKeyword = encodeURIComponent(randomKeyword);
        const url = `https://www.amazon.co.jp/s?k=${encodedKeyword}&tag=${affiliateTag}`;

        linkElement.href = url;
        linkElement.textContent = `${randomKeyword} をAmazonで探す (アソシエイトリンク)`;
    }

    // --- 初期化実行 ---
    handleAuthentication();
    setupAffiliateLink();
});