document.addEventListener('DOMContentLoaded', () => {
    // --- Twitch API 設定 ---
    const CLIENT_ID = 'uowehmui1x4ws4r5xnhtzkxdmwii60';
    const REDIRECT_URI = window.location.origin + window.location.pathname;
    const AUTH_SCOPE = 'user:read:follows';

    // --- DOM要素 ---
    const loginContainer = document.getElementById('login-container');
    const appContainer = document.getElementById('app-container');
    const loginBtn = document.getElementById('login-btn');
    const streamerInput = document.getElementById('streamer-input');
    const addStreamerBtn = document.getElementById('add-streamer-btn');
    const streamerListDiv = document.getElementById('streamer-list');
    const monthViewBtn = document.getElementById('month-view-btn');
    const dayViewBtn = document.getElementById('day-view-btn');
    const prevBtn = document.getElementById('prev-month-btn');
    const nextBtn = document.getElementById('next-month-btn');
    const currentDisplay = document.getElementById('current-month-display');
    const calendarGrid = document.getElementById('calendar-grid');
    const timelineBody = document.getElementById('timeline-body');
    const timelineHeader = document.getElementById('timeline-header');
    const calendarHeader = document.getElementById('calendar-header');
    const nativeDatePicker = document.getElementById('native-date-picker');
    const suggestionsContainer = document.getElementById('suggestions-container');
    const monthPickerModal = document.getElementById('month-picker-modal');
    const modalOverlay = document.getElementById('modal-overlay');


    // --- アプリケーションの状態 ---
    let accessToken = '';
    let streamers = [];
    let streamerDataCache = {};
    let liveStatusSet = new Set();
    let loggedInUser = null;
    let currentDate = new Date();
    let currentView = 'month';
    let monthPickerYear = new Date().getFullYear();

    // --- 1. 認証処理 ---
    function handleAuthentication() {
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);
        if (params.has('access_token')) {
            accessToken = params.get('access_token');
            window.location.hash = '';
            loginContainer.classList.add('hidden');
            appContainer.classList.remove('hidden');
            initializeAppLogic();
        } else {
            const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=token&scope=${AUTH_SCOPE}`;
            loginBtn.href = authUrl;
        }
    }

    // --- 2. アプリケーション初期化 ---
    async function initializeAppLogic() {
        setupEventListeners();
        loggedInUser = await getLoggedInUser();
        if (loggedInUser) {
            await fetchFollowedChannels(loggedInUser.id);
        }
        await renderCurrentView();
    }

    function setupEventListeners() {
        addStreamerBtn.addEventListener('click', () => handleAddStreamer(streamerInput.value));
        streamerInput.addEventListener('keypress', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleAddStreamer(streamerInput.value);
                hideSuggestions();
            }
        });
        streamerListDiv.addEventListener('click', handleRemoveStreamer);
        monthViewBtn.addEventListener('click', () => switchView('month'));
        dayViewBtn.addEventListener('click', () => switchView('day'));
        prevBtn.addEventListener('click', handlePrevClick);
        nextBtn.addEventListener('click', handleNextClick);
        calendarGrid.addEventListener('click', handleDayClick);
        currentDisplay.addEventListener('click', (e) => {
            if (currentView === 'day') {
                const rect = e.target.getBoundingClientRect();
                nativeDatePicker.style.position = 'fixed';
                nativeDatePicker.style.left = `${rect.left}px`;
                nativeDatePicker.style.top = `${rect.bottom}px`;
                nativeDatePicker.showPicker();
            } else {
                showMonthPicker();
            }
        });
        nativeDatePicker.addEventListener('change', (e) => {
            const [year, month, day] = e.target.value.split('-').map(Number);
            currentDate = new Date(year, month - 1, day);
            renderCurrentView();
        });
        streamerInput.addEventListener('input', debouncedHandleSuggestionSearch);
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.streamer-input-container')) {
                hideSuggestions();
            }
        });
        suggestionsContainer.addEventListener('click', handleSuggestionClick);
        if(modalOverlay) modalOverlay.addEventListener('click', hideMonthPicker);
    }

    // --- 3. API通信 ---
    async function twitchApiFetch(endpoint, pagination = false) {
        let allData = [];
        let cursor = null;
        let url = `https://api.twitch.tv/helix/${endpoint}`;
        const fetchPage = async (fetchUrl) => {
            try {
                const response = await fetch(fetchUrl, { headers: { 'Authorization': `Bearer ${accessToken}`, 'Client-Id': CLIENT_ID } });
                if (!response.ok) {
                    if (response.status === 401) { alert('認証が切れました。再度ログインしてください。'); window.location.hash = ''; handleAuthentication(); }
                    throw new Error(`API request failed: ${response.status}`);
                }
                return await response.json();
            } catch (error) { console.error('Twitch API fetch error:', error); return null; }
        };
        let data = await fetchPage(url);
        if (data && data.data) allData.push(...data.data);
        if (pagination) {
            while (data && data.pagination && data.pagination.cursor) {
                cursor = data.pagination.cursor;
                const separator = url.includes('?') ? '&' : '?';
                data = await fetchPage(`${url}${separator}after=${cursor}`);
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
            streamers = followed.map(f => f.broadcaster_login);
            followed.forEach(f => {
                streamerDataCache[f.broadcaster_login] = { id: f.broadcaster_id, display_name: f.broadcaster_name, login: f.broadcaster_login };
            });
        }
    }

    async function getStreamerData(loginName) {
        if (streamerDataCache[loginName]) return streamerDataCache[loginName];
        const users = await twitchApiFetch(`users?login=${loginName}`);
        if (users && users.length > 0) {
            const userData = users[0];
            streamerDataCache[loginName] = { id: userData.id, display_name: userData.display_name, login: userData.login };
            return streamerDataCache[loginName];
        }
        return null;
    }

    async function fetchLiveStatuses(loginNames) {
        if (loginNames.length === 0) return new Set();
        const query = loginNames.map(name => `user_login=${name}`).join('&');
        const liveData = await twitchApiFetch(`streams?${query}`);
        return new Set(liveData.map(stream => stream.user_login));
    }

    async function fetchVodsForMonth(userId, date) {
        const year = date.getFullYear();
        const month = date.getMonth();
        const data = await twitchApiFetch(`videos?user_id=${userId}&period=month&first=100&type=archive`, true);
        if (!data) return [];
        return data.filter(vod => {
            const vodDate = new Date(vod.created_at);
            return vodDate.getFullYear() === year && vodDate.getMonth() === month;
        });
    }

    async function fetchChannelSuggestions(query) {
        if (!query) return [];
        const data = await twitchApiFetch(`search/channels?query=${encodeURIComponent(query)}&first=5`);
        return data || [];
    }

    // --- 4. レンダリングロジック ---
    async function renderMonthlyView() {
        currentDisplay.classList.add('clickable');
        currentDisplay.textContent = `${currentDate.getFullYear()}年 ${currentDate.getMonth() + 1}月`;
        calendarGrid.innerHTML = '<div class="loading">Loading...</div>';
        renderCalendarHeader();
        const vodsByDay = {};
        const streamerPromises = streamers.map(async (loginName) => {
            const streamerData = await getStreamerData(loginName);
            if (!streamerData) return;
            const vods = await fetchVodsForMonth(streamerData.id, currentDate);
            vods.forEach(vod => {
                const day = new Date(vod.created_at).getDate();
                if (!vodsByDay[day]) vodsByDay[day] = new Set();
                vodsByDay[day].add(loginName);
            });
        });
        await Promise.all(streamerPromises);
        calendarGrid.innerHTML = '';
        const date = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
        const firstDay = date.getDay();
        const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
        for (let i = 0; i < firstDay; i++) calendarGrid.appendChild(createDayCell(null));
        for (let i = 1; i <= daysInMonth; i++) {
            const cell = createDayCell(new Date(date.getFullYear(), date.getMonth(), i), vodsByDay[i]);
            calendarGrid.appendChild(cell);
        }
    }

    function createDayCell(date, activeStreamers = new Set()) {
        const cell = document.createElement('div');
        cell.className = 'day-cell';
        if (!date) { cell.classList.add('not-current-month'); return cell; }
        cell.dataset.date = date.toISOString();
        cell.innerHTML = `<div class="day-number">${date.getDate()}</div><div class="activity-indicators"></div>`;
        const indicators = cell.querySelector('.activity-indicators');
        activeStreamers.forEach(loginName => {
            const dot = document.createElement('div');
            dot.className = 'activity-dot';
            dot.style.backgroundColor = getStreamerColor(loginName);
            indicators.appendChild(dot);
        });
        return cell;
    }

    async function renderDailyView() {
        currentDisplay.classList.add('clickable');
        currentDisplay.textContent = `${currentDate.getFullYear()}年 ${currentDate.getMonth() + 1}月 ${currentDate.getDate()}日`;
        timelineBody.innerHTML = '<div class="loading">Loading...</div>';
        renderTimeMarkers();
        const rows = await Promise.all(streamers.map(loginName => createTimelineRow(loginName)));
        timelineBody.innerHTML = '';
        rows.forEach(row => timelineBody.appendChild(row));
    }

    async function createTimelineRow(loginName) {
        const row = document.createElement('div');
        row.className = 'timeline-row';
        const nameDiv = document.createElement('div');
        nameDiv.className = 'streamer-name';
        const track = document.createElement('div');
        track.className = 'timeline-track';
        row.appendChild(nameDiv);
        row.appendChild(track);
        const streamerData = await getStreamerData(loginName);
        if (!streamerData) { nameDiv.textContent = loginName; return row; }
        const isLive = liveStatusSet.has(loginName);
        if (isLive) {
            nameDiv.innerHTML = `<div class="live-indicator"></div><a href="https://www.twitch.tv/${loginName}" target="_blank">${streamerData.display_name}</a>`;
        } else {
            nameDiv.textContent = streamerData.display_name;
        }
        const allVods = await twitchApiFetch(`videos?user_id=${streamerData.id}&type=archive&first=100`, true);
        if (allVods) {
            const dayVods = allVods.filter(vod => {
                const vodDate = new Date(vod.created_at);
                return vodDate.getFullYear() === currentDate.getFullYear() && vodDate.getMonth() === currentDate.getMonth() && vodDate.getDate() === currentDate.getDate();
            });
            dayVods.forEach(vod => track.appendChild(createBroadcastBlock(vod)));
        }
        return row;
    }

    function createBroadcastBlock(vod) {
        const block = document.createElement('div');
        block.className = 'broadcast-block';
        block.innerHTML = `<div class="broadcast-title-text">${vod.title}</div>`;
        const startTime = new Date(vod.created_at);
        const endTime = new Date(startTime.getTime() + parseTwitchDuration(vod.duration));
        const startOfDay = new Date(currentDate).setHours(0, 0, 0, 0);
        const totalDaySeconds = 24 * 60 * 60;
        const startSeconds = (startTime - startOfDay) / 1000;
        const endSeconds = (endTime - startOfDay) / 1000;
        block.style.left = `${Math.max(0, (startSeconds / totalDaySeconds) * 100)}%`;
        block.style.width = `${(Math.min(endSeconds, totalDaySeconds) - Math.max(startSeconds, 0)) / totalDaySeconds * 100}%`;
        block.addEventListener('click', () => window.open(vod.url, '_blank'));
        return block;
    }

    // --- 5. 月選択ピッカー ---
    function showMonthPicker() {
        monthPickerYear = currentDate.getFullYear();
        if(modalOverlay) modalOverlay.classList.remove('hidden');
        monthPickerModal.classList.remove('hidden');
        renderMonthPicker();
    }

    function hideMonthPicker() {
        if(modalOverlay) modalOverlay.classList.add('hidden');
        monthPickerModal.classList.add('hidden');
    }

    function renderMonthPicker() {
        monthPickerModal.innerHTML = '';
        const nav = document.createElement('div');
        nav.id = 'month-picker-nav';
        nav.innerHTML = `
            <button id="picker-prev-year-btn">&lt;</button>
            <h3 id="picker-year-display">${monthPickerYear}</h3>
            <button id="picker-next-year-btn">&gt;</button>
        `;
        monthPickerModal.appendChild(nav);

        const grid = document.createElement('div');
        grid.className = 'month-grid';
        const months = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
        months.forEach((month, index) => {
            const item = document.createElement('div');
            item.className = 'month-item';
            item.textContent = month;
            item.dataset.month = index;
            if (index === currentDate.getMonth() && monthPickerYear === currentDate.getFullYear()) {
                item.classList.add('selected');
            }
            grid.appendChild(item);
        });
        monthPickerModal.appendChild(grid);

        monthPickerModal.querySelector('#picker-prev-year-btn').addEventListener('click', () => {
            monthPickerYear--;
            renderMonthPicker();
        });
        monthPickerModal.querySelector('#picker-next-year-btn').addEventListener('click', () => {
            monthPickerYear++;
            renderMonthPicker();
        });
        grid.addEventListener('click', (e) => {
            const item = e.target.closest('.month-item');
            if (item) {
                currentDate = new Date(monthPickerYear, parseInt(item.dataset.month), 1);
                hideMonthPicker();
                renderMonthlyView();
            }
        });
    }

    // --- 6. サジェスト機能 ---
    const debouncedHandleSuggestionSearch = debounce(handleSuggestionSearch, 300);

    async function handleSuggestionSearch() {
        const query = streamerInput.value.trim();
        if (query.length < 2) { hideSuggestions(); return; }
        const suggestions = await fetchChannelSuggestions(query);
        renderSuggestions(suggestions);
    }

    function renderSuggestions(channels) {
        if (channels.length === 0) { hideSuggestions(); return; }
        suggestionsContainer.innerHTML = '';
        channels.forEach(channel => {
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            item.dataset.login = channel.broadcaster_login;
            item.innerHTML = `<img src="${channel.thumbnail_url}" alt=""><span>${channel.display_name} (${channel.broadcaster_login})</span>`;
            suggestionsContainer.appendChild(item);
        });
        suggestionsContainer.classList.remove('hidden');
    }

    function handleSuggestionClick(e) {
        const item = e.target.closest('.suggestion-item');
        if (item) {
            const login = item.dataset.login;
            streamerInput.value = login;
            handleAddStreamer(login);
            hideSuggestions();
        }
    }

    function hideSuggestions() {
        suggestionsContainer.classList.add('hidden');
    }

    // --- 7. ヘルパー関数 & イベントハンドラ ---
    function handlePrevClick() {
        if (currentView === 'month') { currentDate.setMonth(currentDate.getMonth() - 1); } else { currentDate.setDate(currentDate.getDate() - 1); }
        renderCurrentView();
    }

    function handleNextClick() {
        if (currentView === 'month') { currentDate.setMonth(currentDate.getMonth() + 1); } else { currentDate.setDate(currentDate.getDate() + 1); }
        renderCurrentView();
    }

    async function handleAddStreamer(name) {
        const loginName = name.trim().toLowerCase();
        if (loginName && !streamers.includes(loginName)) {
            const data = await getStreamerData(loginName);
            if (data) { streamers.push(loginName); renderCurrentView(); }
            else { alert('存在しないチャンネル名です。'); }
        }
        streamerInput.value = '';
    }

    function handleRemoveStreamer(e) {
        if (e.target.classList.contains('remove-streamer-btn')) {
            const name = e.target.dataset.streamer;
            streamers = streamers.filter(s => s !== name);
            renderCurrentView();
        }
    }

    function handleDayClick(e) {
        const dayCell = e.target.closest('.day-cell');
        if (dayCell && !dayCell.classList.contains('not-current-month')) {
            currentDate = new Date(dayCell.dataset.date);
            switchView('day');
        }
    }

    function switchView(view) {
        currentView = view;
        [monthViewBtn, dayViewBtn].forEach(btn => btn.classList.remove('active'));
        [document.getElementById('monthly-view'), document.getElementById('daily-view')].forEach(v => v.classList.remove('active'));
        if (view === 'month') { monthViewBtn.classList.add('active'); document.getElementById('monthly-view').classList.add('active'); }
        else { dayViewBtn.classList.add('active'); document.getElementById('daily-view').classList.add('active'); }
        renderCurrentView();
    }

    async function renderCurrentView() {
        liveStatusSet = await fetchLiveStatuses(streamers);
        await updateStreamerList();
        if (currentView === 'month') { await renderMonthlyView(); } 
        else { await renderDailyView(); }
    }

    function renderCalendarHeader(){
        calendarHeader.innerHTML = '';
        ['日', '月', '火', '水', '木', '金', '土'].forEach(day => { calendarHeader.innerHTML += `<div>${day}</div>`; });
    }

    function renderTimeMarkers() {
        timelineHeader.innerHTML = '<div class="time-markers-corner"></div><div class="time-markers"></div>';
        const markers = timelineHeader.querySelector('.time-markers');
        for (let i = 0; i < 24; i += 3) { markers.innerHTML += `<span>${i}:00</span>`; }
    }

    async function updateStreamerList() {
        streamerListDiv.innerHTML = '';
        for (const loginName of streamers) {
            const streamerData = await getStreamerData(loginName);
            const displayName = streamerData ? streamerData.display_name : loginName;
            const isLive = liveStatusSet.has(loginName);
            const tag = document.createElement('div');
            tag.className = 'streamer-tag';
            let content = isLive ? `<div class="live-indicator"></div><a href="https://www.twitch.tv/${loginName}" target="_blank">${displayName}</a>` : `<span>${displayName}</span>`;
            content += `<button class="remove-streamer-btn" data-streamer="${loginName}">&times;</button>`;
            tag.innerHTML = content;
            streamerListDiv.appendChild(tag);
        }
    }

    function getStreamerColor(streamer) {
        let hash = 0;
        for (let i = 0; i < streamer.length; i++) hash = streamer.charCodeAt(i) + ((hash << 5) - hash);
        const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
        return '#' + '00000'.substring(0, 6 - c.length) + c;
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

    // --- アプリケーション開始 ---
    handleAuthentication();
});
