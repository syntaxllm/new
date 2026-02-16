'use client';
import { useEffect, useState, useRef } from 'react';

// Simple spinner component
const Spinner = () => (
    <div className="w-4 h-4 border-2 border-gray-400 border-t-teams-primary rounded-full animate-spin"></div>
);

// LOG VIEWER COMPONENT
const LogViewer = ({ onClose, logId, contained = false }) => {
    const [logs, setLogs] = useState([]);
    const logEndRef = useRef(null);

    useEffect(() => {
        let intervalId = null;

        const fetchLogs = async () => {
            try {
                if (!logId) return;
                const res = await fetch(`/api/bot/log?logId=${encodeURIComponent(logId)}&t=${Date.now()}`);
                if (res.ok) {
                    const text = await res.text();
                    setLogs(text.split('\n'));
                    // Stop polling if the bot has finished
                    if (text.includes('Process exited')) {
                        if (intervalId) clearInterval(intervalId);
                    }
                }
            } catch (e) { }
        };

        fetchLogs();
        intervalId = setInterval(fetchLogs, 1000);
        return () => clearInterval(intervalId);
    }, [logId]);

    useEffect(() => {
        if (logEndRef.current) {
            logEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs]);

    const containerClass = contained
        ? "flex-1 flex flex-col min-h-0 bg-transparent"
        : "w-[450px] bg-[#1e1e1e] border-l border-teams-border flex flex-col shadow-2xl z-50 absolute right-0 top-12 bottom-0 backdrop-blur-sm bg-opacity-95";

    return (
        <div className={containerClass}>
            {!contained && (
                <div className="px-4 py-3 bg-[#2d2d2d] border-b border-[#3e3e3e] flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                            <span className="text-xs font-bold text-gray-400 font-mono">LIVE ACTIVITY</span>
                        </div>
                        <button onClick={onClose} className="text-gray-400 hover:text-white p-1">✕</button>
                    </div>
                    <div className="font-mono text-sm text-white font-bold truncate">
                        {/* Show last relevant log */}
                        {(() => {
                            const relevant = logs.filter(l => ['🤖', '🔗', '✅', '🔍', '✍️', '👆', '⏳', '🔒', '🔴', '📸', '❌', '⚠️', '🟡', '🟢', 'ℹ️', 'IN_MEETING', 'IN_LOBBY', 'PRE_JOIN', 'JOINING', 'NAVIGATING', 'FAILED'].some(p => l.trim().startsWith(p) || l.includes(p)));
                            return relevant.length > 0 ? relevant[relevant.length - 1] : 'Ready...';
                        })()}
                    </div>
                </div>
            )}

            {/* Scrolling History (Filtered) */}
            <div className="flex-1 overflow-auto p-3 font-mono text-[11px] text-gray-400 bg-black/95 leading-relaxed scrollbar-thin scrollbar-thumb-gray-800">
                {logs.map((line, i) => {
                    const isRelevant = ['🤖', '🔗', '✅', '🔍', '✍️', '👆', '⏳', '🔒', '🔴', '📸', '❌', '⚠️', '🟡', '🟢', 'ℹ️', 'IN_MEETING', 'IN_LOBBY', 'PRE_JOIN', 'JOINING', 'NAVIGATING', 'FAILED', 'JOIN_TIMEOUT'].some(p => line.trim().startsWith(p) || line.includes(p));
                    if (!isRelevant) return null; // Hide backend/technical logs

                    const isError = line.includes('Error') || line.includes('FAILED') || line.includes('❌');
                    const isSTT = line.includes('✨') || line.includes('STT') || line.includes('transcription');

                    // Parse timestamp if present [2026-...]
                    let displayTime = new Date().toLocaleTimeString('en-US', { hour12: false });
                    let content = line;
                    const timeMatch = line.match(/^\[(20\d{2}-.*?)\]\s*(.*)/);
                    if (timeMatch) {
                        try {
                            const date = new Date(timeMatch[1]);
                            if (!isNaN(date)) {
                                displayTime = date.toLocaleTimeString('en-US', { hour12: false });
                                content = timeMatch[2]; // Use rest of string
                            }
                        } catch (e) { }
                    }

                    return (
                        <div key={i} className={`mb-1 pl-2 border-l-2 transition-all duration-300 
                            ${isError ? 'border-red-500 bg-red-900/10' :
                                isSTT ? 'border-cyan-400 bg-cyan-950/20 text-cyan-300 animate-pulse' :
                                    'border-transparent hover:border-blue-500'}`}>
                            <span className="text-gray-600 mr-2 text-[10px] tracking-wide">[{displayTime}]</span>
                            <span className={isError ? 'text-red-400 font-bold' : isSTT ? 'text-cyan-300 font-bold' : 'text-green-400/90'}>
                                {content}
                            </span>
                        </div>
                    );
                })}

                {/* Dynamic Cursor Effect */}
                <div className="mt-4 flex items-center gap-2 pl-2 opacity-80">
                    <span className="w-1.5 h-4 bg-green-500 animate-[pulse_1s_ease-in-out_infinite] block box-shadow-green cursor-blink"></span>
                    <span className="text-xs text-green-500/50 italic tracking-wider">AWAITING SIGNAL...</span>
                </div>

                {/* Auto-scroll anchor */}
                <div ref={logEndRef} style={{ float: "left", clear: "both" }} />
            </div>
        </div>
    );
};

// LIVE TRANSCRIPT COMPONENT
const LiveTranscript = ({ vttContent }) => {
    const endRef = useRef(null);

    // Auto-scroll logic
    useEffect(() => {
        endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [vttContent]);

    if (!vttContent) return <div className="text-gray-500 italic p-4 text-center">Waiting for speech...</div>;

    const segments = [];
    const lines = vttContent.split('\n');
    let currentSegment = null;

    lines.forEach(line => {
        if (line.includes('-->')) {
            currentSegment = { time: line.split('-->')[0].trim() };
        } else if (line.startsWith('<v')) {
            const match = line.match(/<v (.*?)>(.*)<\/v>/);
            if (match && currentSegment) {
                currentSegment.speaker = match[1];
                currentSegment.text = match[2];
                segments.push(currentSegment);
                currentSegment = null;
            }
        }
    });

    return (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {segments.map((seg, i) => (
                <div key={i} className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-teams-primary/20 flex items-center justify-center text-xs font-bold text-teams-primary border border-teams-primary/30">
                        {seg.speaker?.charAt(0) || '?'}
                    </div>
                    <div className="flex-1">
                        <div className="flex items-baseline gap-2 mb-1">
                            <span className="font-semibold text-sm text-gray-200">{seg.speaker}</span>
                            <span className="text-[10px] text-gray-500 font-mono">{seg.time}</span>
                        </div>
                        <p className="text-gray-300 text-sm leading-relaxed">{seg.text}</p>
                    </div>
                </div>
            ))}
            <div ref={endRef} />
        </div>
    );
};


export default function MeetingAI() {
    const [meetings, setMeetings] = useState([]);
    const [selectedMeeting, setSelectedMeeting] = useState(null);
    const [selectedBot, setSelectedBot] = useState(null); // New state for live monitoring
    const [view, setView] = useState('overview');
    const [chatMessages, setChatMessages] = useState([]);
    const [chatInput, setChatInput] = useState('');
    const [summary, setSummary] = useState(null);
    const [actionItems, setActionItems] = useState(null);
    const [status, setStatus] = useState('');
    const [theme, setTheme] = useState('dark');

    // UI Layout State
    const [showLogs, setShowLogs] = useState(true); // Default Open 

    // Bot & Meeting State
    const [activeMeetings, setActiveMeetings] = useState([]);
    const [activeBots, setActiveBots] = useState([]); // Live bot sessions
    const [manualLink, setManualLink] = useState('');
    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [userInfo, setUserInfo] = useState(null);
    const [activeLogId, setActiveLogId] = useState(null);

    const chatEndRef = useRef(null);

    useEffect(() => {
        const savedTheme = localStorage.getItem('theme') || 'dark';
        setTheme(savedTheme);
        document.documentElement.classList.toggle('dark', savedTheme === 'dark');

        loadMeetings();
        checkLogin();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (isLoggedIn) {
            loadActiveMeetings();
            loadActiveBots();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLoggedIn]);

    async function loadActiveBots() {
        try {
            const res = await fetch('/api/bot/active');
            if (res.ok) {
                const data = await res.json();
                const bots = data.bots || [];
                setActiveBots(bots);

                // If selected bot is gone, clear it
                if (selectedBot && !bots.find(b => b.id === selectedBot.id)) {
                    setSelectedBot(null);
                }
            }
        } catch (e) { console.error('Error loading active bots:', e); }
    }

    useEffect(() => {
        if (view === 'chat' && chatEndRef.current) {
            chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [chatMessages, view]);

    async function checkLogin() {
        const hasToken = document.cookie.includes('ms_token');
        setIsLoggedIn(hasToken);
        if (hasToken) {
            await loadUserInfo();
        }
    }

    async function loadUserInfo() {
        try {
            const res = await fetch('/api/user/info');
            if (res.ok) setUserInfo(await res.json());
        } catch (e) {
            console.error('Error loading user info:', e);
        }
    }

    async function loadMeetings() {
        try {
            const res = await fetch('/api/transcripts');
            const data = await res.json();
            setMeetings(data || []);
        } catch (e) {
            console.error(e);
            setStatus('Error loading library.');
        }
    }

    // Auto-refresh library every 10s to show incoming bot transcripts
    useEffect(() => {
        const interval = setInterval(() => {
            loadMeetings();
            loadActiveBots();
        }, 10000);
        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // --- BOT & MEETING LOGIC ---

    async function loadActiveMeetings() {
        try {
            const res = await fetch('/api/meetings/active');
            if (res.ok) {
                const data = await res.json();
                setActiveMeetings(data.meetings || []);
            }
        } catch (e) { console.error(e); }
    }

    async function launchBot(meeting) {
        if (!meeting.webUrl) return alert('No Join URL found for this meeting');

        setStatus(`Launching Bot for: ${meeting.subject}...`);
        setShowLogs(true); // Auto-open logs
        try {
            const res = await fetch('/api/bot/launch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    joinUrl: meeting.webUrl,
                    meetingId: meeting.id,
                    subject: meeting.subject
                })
            });
            const data = await res.json();
            if (data.success) {
                if (data.logId) setActiveLogId(data.logId);
                loadActiveBots(); // Refresh UI immediately
            } else {
                alert(`❌ Failed: ${data.error}`);
            }
        } catch (e) {
            alert(`Error: ${e.message}`);
        }
        setStatus('');
    }

    async function joinViaLink() {
        if (!manualLink.trim()) return alert('Please paste a Teams link first.');

        setStatus(`Launching Bot for link...`);
        setShowLogs(true); // Auto-open logs
        try {
            const res = await fetch('/api/bot/launch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ joinUrl: manualLink })
            });
            const data = await res.json();
            if (data.success) {
                setManualLink('');
                if (data.logId) setActiveLogId(data.logId);
                loadActiveBots(); // Refresh UI immediately
            } else {
                alert(`❌ Failed: ${data.error}`);
            }
        } catch (e) {
            alert(`Error: ${e.message}`);
        }
        setStatus('');
    }

    async function handleDeleteMeeting(id) {
        if (!confirm('Are you sure you want to delete this meeting? This cannot be undone.')) return;
        try {
            const res = await fetch(`/api/meetings/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setMeetings(prev => prev.filter(m => m.meetingId !== id));
                if (selectedMeeting?.meetingId === id) setSelectedMeeting(null);
            } else {
                alert('Failed to delete meeting');
            }
        } catch (e) { alert('Delete failed'); }
    }

    async function doUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        setStatus('Uploading file...');
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (data.success) {
            await loadMeetings();
            setStatus('Uploaded successfully.');
        } else {
            setStatus(`Upload error: ${data.error}`);
        }
        setTimeout(() => setStatus(''), 3000);
    }

    // --- AI FEATURES ---

    async function getSummary() {
        if (summary) return;
        setStatus('Generating AI summary...');
        try {
            const res = await fetch(`/api/summary/${selectedMeeting.meetingId}`);
            setSummary(await res.json());
        } catch (e) { console.error(e); }
        setStatus('');
    }

    async function getActions() {
        if (actionItems) return;
        setStatus('Extracting action items...');
        try {
            const res = await fetch(`/api/actions/${selectedMeeting.meetingId}`);
            setActionItems(await res.json());
        } catch (e) { console.error(e); }
        setStatus('');
    }

    async function sendChat() {
        if (!chatInput.trim()) return;
        const newMessages = [...chatMessages, { role: 'user', content: chatInput }];
        setChatMessages(newMessages);
        setChatInput('');
        setStatus('AI is thinking...');
        try {
            const res = await fetch(`/api/chat/${selectedMeeting.meetingId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: chatInput, chatHistory: chatMessages })
            });
            const data = await res.json();
            const assistantMessage = data.error ? `Error: ${data.error}` : data.answer;
            setChatMessages([...newMessages, { role: 'assistant', content: assistantMessage, sources: data.sources }]);
        } catch (error) {
            setChatMessages([...newMessages, { role: 'assistant', content: `An unexpected error occurred: ${error.message}` }]);
        }
        setStatus('');
    }

    const handleMeetingSelect = (m) => {
        setSelectedMeeting(m);
        setSelectedBot(null); // Clear live bot selection
        setView('overview');
        setChatMessages([]);
        setSummary(null);
        setActionItems(null);
    };

    const handleBotSelect = (bot) => {
        setSelectedBot(bot);
        setSelectedMeeting(null); // Clear archived meeting
        setView('live');
    };

    const toggleTheme = () => {
        const newTheme = theme === 'light' ? 'dark' : 'light';
        setTheme(newTheme);
        localStorage.setItem('theme', newTheme);
        document.documentElement.classList.toggle('dark', newTheme === 'dark');
    };

    return (
        <div className="flex flex-col h-screen bg-teams-bg text-teams-text-primary font-sans">
            {/* Header */}
            <header className="flex-shrink-0 bg-[#333366] text-white h-12 px-4 flex items-center justify-between shadow-md">
                <div className="flex items-center gap-2 text-lg font-semibold">
                    <span>⌯</span> MeetingAI
                </div>
                <div className="flex items-center gap-4 text-sm">

                    {/* Log Toggle */}
                    <button
                        onClick={() => setShowLogs(!showLogs)}
                        className={`text-xs px-2 py-1 rounded border ${showLogs ? 'bg-white/20 border-white/50' : 'border-transparent hover:bg-white/10'}`}
                    >
                        &gt;_ Terminal
                    </button>

                    {status && <span className="opacity-80 text-xs italic">{status}</span>}
                    <button onClick={toggleTheme} className="p-2 rounded-full hover:bg-white/10" title="Toggle Theme">
                        {theme === 'light' ? '🌙' : '☀️'}
                    </button>

                    {/* User Profile in Header */}
                    {isLoggedIn && userInfo && (
                        <div className="flex items-center gap-3 bg-black/20 px-3 py-1 rounded-md border border-white/10">
                            <div className="flex flex-col text-right leading-tight">
                                <span className="text-xs font-bold text-white">{userInfo.displayName}</span>
                                <span className="text-[10px] text-green-400">● Connected</span>
                            </div>
                            <button
                                onClick={() => { document.cookie = 'ms_token=; Max-Age=0'; setIsLoggedIn(false); setUserInfo(null); }}
                                className="text-xs text-red-300 hover:text-white hover:underline"
                                title="Disconnect"
                            >
                                ✕
                            </button>
                        </div>
                    )}
                    {!isLoggedIn && (
                        <button
                            onClick={() => window.location.href = '/api/auth/login?prompt=select_account'}
                            className="text-xs bg-teams-primary hover:bg-teams-secondary text-white font-bold py-1 px-3 rounded"
                        >
                            Connect Teams
                        </button>
                    )}
                </div>
            </header>

            <div className="flex flex-1 overflow-hidden">
                {/* Sidebar (Full Left) */}
                <div className="w-72 bg-teams-surface flex-shrink-0 flex flex-col border-r border-teams-border">

                    {/* --- NEW BOT ACTIONS SECTION --- */}
                    {isLoggedIn && (
                        <div className="p-4 border-b border-teams-border bg-black/10">
                            <h3 className="text-xs uppercase font-bold text-teams-text-secondary mb-3 flex justify-between items-center">
                                <span>Bot Actions</span>
                                <button onClick={loadActiveMeetings} className="hover:text-white" title="Refresh Active Meetings">↻</button>
                            </h3>

                            {/* 1. AUTO DETECT / JOIN CURRENT */}
                            {activeMeetings.find(m => m.isCurrent) && (
                                <div className="mb-4">
                                    <div className="text-xs text-green-400 font-bold mb-1 flex items-center gap-2">
                                        <span className="relative flex h-2 w-2">
                                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                                        </span>
                                        Happening Now
                                    </div>
                                    <button
                                        onClick={() => launchBot(activeMeetings.find(m => m.isCurrent))}
                                        className="w-full py-2 bg-gradient-to-r from-green-700 to-green-600 hover:from-green-600 hover:to-green-500 text-white text-xs font-bold rounded shadow-lg flex items-center justify-center gap-2 transition-all"
                                    >
                                        <span>🚀 Join &quot;{activeMeetings.find(m => m.isCurrent).subject}&quot;</span>
                                    </button>
                                </div>
                            )}

                            {/* 2. MANUAL JOIN */}
                            <div className="space-y-2">
                                <label className="text-[10px] text-gray-400 uppercase font-semibold">Join by Link</label>
                                <div className="flex gap-1">
                                    <input
                                        type="text"
                                        value={manualLink}
                                        onChange={(e) => setManualLink(e.target.value)}
                                        placeholder="Paste Teams URL..."
                                        className="flex-1 bg-black/20 border border-gray-700 text-xs text-white rounded px-2 py-1 focus:border-teams-primary focus:outline-none"
                                    />
                                    <button
                                        onClick={joinViaLink}
                                        disabled={!manualLink}
                                        className="bg-teams-primary hover:bg-teams-secondary text-white px-3 py-1 rounded text-xs font-bold disabled:opacity-50"
                                    >
                                        Go
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* UPCOMING / ACTIVE MEETINGS (Calendar) */}
                    {isLoggedIn && activeMeetings.length > 0 && (
                        <div className="p-4 border-b border-teams-border">
                            <h3 className="text-xs uppercase font-bold text-gray-500 mb-2">Calendar</h3>
                            <div className="space-y-2">
                                {activeMeetings.map(m => (
                                    <div key={m.id} className={`p-2 bg-[#2D2D2D] rounded border ${m.isCurrent ? 'border-green-500/50' : 'border-gray-700'} hover:border-teams-primary group`}>
                                        <div className="flex justify-between items-start mb-1">
                                            <span className="text-xs font-semibold truncate text-white max-w-[150px]">{m.subject}</span>
                                        </div>
                                        <div className="text-[10px] text-gray-400 mb-2">
                                            {new Date(m.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </div>
                                        {!m.isCurrent && (
                                            <button
                                                onClick={() => launchBot(m)}
                                                className="w-full py-1 bg-gray-700 hover:bg-gray-600 text-white text-[10px] font-bold rounded flex items-center justify-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity"
                                            >
                                                <span>Join</span>
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Recorded Meetings (Library) */}
                    <div className="flex-1 flex flex-col overflow-hidden">
                        <h3 className="p-4 pb-2 text-xs uppercase font-bold text-teams-text-secondary">Library</h3>
                        <div className="flex-1 overflow-y-auto px-2 space-y-1">
                            {/* Live Active Bots Placeholder */}
                            {activeBots.map(bot => (
                                <div
                                    key={bot.id}
                                    onClick={() => handleBotSelect(bot)}
                                    className={`p-3 rounded-md border-l-4 cursor-pointer mb-2 transition-all ${selectedBot?.id === bot.id ? 'bg-green-500/20 border-green-500 ring-1 ring-green-500' : 'bg-green-900/10 border-green-500 hover:bg-green-900/20'
                                        } ${bot.status === 'IN_MEETING' ? 'animate-pulse' : ''}`}
                                >
                                    <div className="flex items-center justify-between mb-1">
                                        <h4 className="font-semibold text-sm text-green-400">
                                            {bot.status === 'LAUNCHING' || bot.status === 'NAVIGATING' ? 'Initializing Bot...' :
                                                bot.status === 'PRE_JOIN' ? 'Entering Name...' :
                                                    bot.status === 'JOINING' ? 'Connecting...' :
                                                        bot.status === 'IN_LOBBY' ? 'Waiting in Lobby...' :
                                                            bot.status === 'IN_MEETING' ? 'Live Recording...' :
                                                                bot.status === 'FAILED' ? 'Connection Failed' : 'Processing...'}
                                        </h4>
                                        <span className={`text-[9px] px-1 rounded-sm font-bold uppercase tracking-tighter ${bot.status === 'IN_MEETING' ? 'bg-green-500 text-black' :
                                            bot.status === 'FAILED' ? 'bg-red-500 text-white' :
                                                'bg-amber-500 text-black'
                                            }`}>
                                            {bot.status}
                                        </span>
                                    </div>
                                    <p className="text-[10px] text-green-400/70 truncate">{bot.metadata?.subject || 'Meeting in progress'}</p>
                                    {bot.currentSpeaker && (
                                        <div className="mt-2 flex items-center gap-2 text-[10px] text-white/80 bg-green-500/20 px-2 py-1 rounded">
                                            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-[ping_1.5s_linear_infinite]" />
                                            <span>Speaking: <span className="font-bold">{bot.currentSpeaker}</span></span>
                                        </div>
                                    )}
                                </div>
                            ))}

                            {meetings.length === 0 && activeBots.length === 0 && (
                                <div className="px-2 py-4 text-sm text-center text-teams-text-secondary/70 italic">
                                    No transcripts found.
                                </div>
                            )}

                            {meetings.map(m => {
                                const isRecent = new Date(m.importedAt) > new Date(Date.now() - 12 * 60 * 60 * 1000);
                                return (
                                    <div
                                        key={m.meetingId}
                                        className={`group relative p-3 rounded-md cursor-pointer border-l-4 ${selectedMeeting?.meetingId === m.meetingId ? 'bg-black/20 border-teams-primary' : 'border-transparent hover:bg-white/5'}`}
                                        onClick={() => handleMeetingSelect(m)}
                                    >
                                        <div className="flex items-center gap-2 mb-1">
                                            <h4 className="font-semibold truncate text-sm">
                                                {m.subject || m.meetingId}
                                            </h4>
                                            {isRecent && <span className="text-[9px] bg-teams-primary/20 text-teams-primary px-1 rounded-sm font-bold border border-teams-primary/30">RECENT</span>}
                                        </div>
                                        <p className="text-xs text-teams-text-secondary">
                                            {m.entries?.length || 0} segments • {new Date(m.importedAt || Date.now()).toLocaleDateString()}
                                        </p>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleDeleteMeeting(m.meetingId); }}
                                            className="absolute top-2 right-2 p-1 text-red-500 rounded-full opacity-0 group-hover:opacity-100 hover:bg-red-500/20"
                                            title="Delete Meeting"
                                        >
                                            ✘
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                    <div className="p-4 border-t border-teams-border">
                        <input id="file-upload" type="file" onChange={doUpload} accept=".vtt" className="hidden" />
                        <button className="w-full bg-white/10 hover:bg-white/20 text-teams-text-primary font-semibold py-2 px-4 rounded-md text-sm"
                            onClick={() => document.getElementById('file-upload').click()}>
                            Upload VTT
                        </button>
                    </div>
                </div>

                {/* Main Content (Center) */}
                <main className="flex-1 flex flex-col bg-teams-bg overflow-hidden relative">
                    {selectedBot ? (
                        <div className="flex-1 flex flex-col p-6 space-y-6">
                            <div className="bg-teams-surface rounded-lg shadow-lg p-8 flex flex-col items-center justify-center text-center space-y-4">
                                <div className="w-16 h-16 rounded-full border-4 border-green-500 border-t-transparent animate-spin mb-4" />
                                <h2 className="text-2xl font-bold text-green-400">Live Meeting Session</h2>
                                <p className="text-teams-text-secondary max-w-md">
                                    The bot is currently processed the meeting <b>{selectedBot.metadata?.subject || 'Untitled'}</b>.
                                    Segments will appear in your library automatically once processed.
                                </p>
                                <div className="flex gap-4 mt-4">
                                    <div className="px-4 py-2 rounded bg-white/5 border border-white/10 text-xs font-mono">
                                        Status: <span className="text-green-400">{selectedBot.status}</span>
                                    </div>
                                    <div className="px-4 py-2 rounded bg-white/5 border border-white/10 text-xs font-mono">
                                        ID: <span className="text-teams-text-secondary">{selectedBot.id}</span>
                                    </div>
                                </div>
                            </div>

                            {/* LIVE TRANSCRIPT */}
                            <div className="flex-[2] bg-teams-surface border border-teams-border rounded-lg overflow-hidden flex flex-col min-h-0">
                                <div className="px-4 py-2 bg-black/20 border-b border-teams-border flex justify-between items-center">
                                    <h3 className="text-xs uppercase font-bold text-green-400">Live Transcript</h3>
                                    <span className="text-[10px] text-gray-500">Auto-scrolling</span>
                                </div>
                                <LiveTranscript vttContent={selectedBot.vttContent} />
                            </div>

                            {/* LIVE LOGS */}
                            <div className="flex-1 bg-black/40 rounded-lg p-4 font-mono text-[11px] overflow-hidden flex flex-col min-h-0 border border-t-0 border-white/5">
                                <h3 className="text-xs uppercase font-bold text-white/40 mb-2">Bot Operations Log</h3>
                                <div className="flex-1 overflow-y-auto space-y-1 scrollbar-hide">
                                    <LogViewer logId={selectedBot.id} contained={true} />
                                </div>
                            </div>
                        </div>
                    ) : selectedMeeting ? (
                        <>
                            {/* Stage Header */}
                            <div className="flex-shrink-0 p-6 border-b border-teams-border bg-teams-surface">
                                <h2 className="text-2xl font-bold">{selectedMeeting.meetingId}</h2>
                                <p className="text-sm text-teams-text-secondary">
                                    Source: {selectedMeeting.source} | Duration: {selectedMeeting.durationSeconds || 'Unknown'}s
                                </p>
                                <div className="mt-4 flex gap-6 border-b border-teams-border">
                                    <button onClick={() => setView('overview')} className={`py-2 text-sm font-semibold border-b-2 ${view === 'overview' ? 'text-teams-primary border-teams-primary' : 'text-teams-text-secondary border-transparent hover:text-white'}`}>Transcript</button>
                                    <button onClick={() => { setView('summary'); getSummary(); }} className={`py-2 text-sm font-semibold border-b-2 ${view === 'summary' ? 'text-teams-primary border-teams-primary' : 'text-teams-text-secondary border-transparent hover:text-white'}`}>AI Summary</button>
                                    <button onClick={() => { setView('actions'); getActions(); }} className={`py-2 text-sm font-semibold border-b-2 ${view === 'actions' ? 'text-teams-primary border-teams-primary' : 'text-teams-text-secondary border-transparent hover:text-white'}`}>Action Items</button>
                                    <button onClick={() => setView('chat')} className={`py-2 text-sm font-semibold border-b-2 ${view === 'chat' ? 'text-teams-primary border-teams-primary' : 'text-teams-text-secondary border-transparent hover:text-white'}`}>☕︎ Chat</button>
                                </div>
                            </div>

                            {/* Stage Content */}
                            <div className="flex-1 overflow-y-auto p-6 space-y-6">
                                {view === 'overview' && (
                                    <div className="bg-teams-surface rounded-lg shadow-lg p-6">
                                        <h3 className="text-lg font-semibold mb-4">Transcript Preview</h3>
                                        <div className="space-y-4 text-sm">
                                            {selectedMeeting.entries?.map((e, i) => (
                                                <div key={i} className="flex gap-4 items-start">
                                                    <div className="font-semibold text-teams-secondary w-24 shrink-0">{e.speaker}</div>
                                                    <div className="flex-1">{e.text}</div>
                                                    <div className="text-xs text-teams-text-secondary/70">{e.start}</div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {(view === 'summary' || view === 'actions') && (
                                    <div className="bg-teams-surface rounded-lg shadow-lg p-6">
                                        {(view === 'summary' && !summary) || (view === 'actions' && !actionItems) ? (
                                            <div className="flex items-center gap-2 text-teams-text-secondary"><Spinner /><span>Generating...</span></div>
                                        ) : view === 'summary' ? (
                                            summary.error ? <p className="text-red-400">Error: {summary.error}</p> : <div className="prose prose-invert max-w-none" dangerouslySetInnerHTML={{ __html: summary.summary.replace(/\n/g, '<br/>') }} />
                                        ) : (
                                            actionItems.error ? <p className="text-red-400">Error: {actionItems.error}</p> : (
                                                <table className="w-full text-sm text-left">
                                                    <thead className="border-b-2 border-teams-border">
                                                        <tr>
                                                            <th className="p-2">Task</th><th className="p-2 w-40">Owner</th><th className="p-2 w-24">Priority</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {actionItems.actionItems?.map((item, i) => (
                                                            <tr key={i} className="border-b border-teams-border/50">
                                                                <td className="p-3">{item.task}</td>
                                                                <td className="p-3"><span className="bg-white/10 px-2 py-1 rounded-full text-xs">{item.owner}</span></td>
                                                                <td className={`p-3 font-semibold ${item.priority?.toLowerCase().includes('high') ? 'text-red-400' : ''}`}>{item.priority}</td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            )
                                        )}
                                    </div>
                                )}

                                {view === 'chat' && (
                                    <div className="flex flex-col h-full">
                                        <div className="flex-1 overflow-y-auto p-4 space-y-4">
                                            {chatMessages.length === 0 && <div className="text-center text-teams-text-secondary">Ask questions about the meeting.</div>}
                                            {chatMessages.map((m, i) => (
                                                <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                                    <div className={`max-w-xl p-3 rounded-lg ${m.role === 'user' ? 'bg-teams-primary text-white' : 'bg-teams-surface'}`}>
                                                        <p className="whitespace-pre-wrap">{m.content}</p>
                                                        {m.sources && <div className="mt-2 pt-2 border-t border-white/20 text-xs space-y-1">
                                                            {m.sources.map((s, si) => <div key={si} className="p-1.5 bg-black/20 rounded truncate"><b>Source:</b> {s.text}</div>)}
                                                        </div>}
                                                    </div>
                                                </div>
                                            ))}
                                            <div ref={chatEndRef} />
                                        </div>
                                        <div className="p-4 border-t border-teams-border flex gap-2">
                                            <input
                                                type="text"
                                                value={chatInput}
                                                onChange={e => setChatInput(e.target.value)}
                                                onKeyDown={e => e.key === 'Enter' && sendChat()}
                                                placeholder="Ask a follow-up question..."
                                                className="flex-1 bg-teams-surface border border-teams-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teams-primary"
                                            />
                                            <button onClick={sendChat} className="bg-teams-primary hover:bg-teams-secondary text-white font-semibold py-2 px-4 rounded-md transition-colors">Send</button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="flex flex-col items-center justify-center h-full text-center text-teams-text-secondary">
                            <div className="text-6xl mb-4">☕︎</div>
                            <h3 className="text-xl font-semibold text-teams-text-primary">Select a meeting</h3>
                            <p className="max-w-sm">Use the sidebar to join active meetings or view past transcripts.</p>
                        </div>
                    )}
                </main>

                {/* Right Log Panel */}
                {showLogs && <LogViewer onClose={() => setShowLogs(false)} logId={activeLogId} />}
            </div>
        </div>
    );
}