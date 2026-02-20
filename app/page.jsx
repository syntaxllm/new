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

    // Check if vttContent is actually a JSON array (from DB or Live Bot)
    if (!vttContent || (Array.isArray(vttContent) && vttContent.length === 0)) {
        return <div className="text-gray-500 italic p-4 text-center">Waiting for speech...</div>;
    }

    const segments = [];

    // If we have explicit segments passed via props (could be named differently in parent)
    // In this case, vttContent might BE the array if passed from selectedBot.transcriptSegments

    if (Array.isArray(vttContent)) {
        vttContent.forEach(item => {
            segments.push({
                time: item.start_time ? `${new Date(item.start_time * 1000).toISOString().substr(11, 8)}` : (item.time || '00:00:00'),
                speaker: item.speaker_id || item.speaker || 'Unknown',
                text: item.text
            });
        });
    } else if (typeof vttContent === 'string') {
        // Parse VTT String
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
    }

    const getSpeakerColor = (name) => {
        const colors = [
            'text-blue-400 bg-blue-400/10 border-blue-400/30',
            'text-purple-400 bg-purple-400/10 border-purple-400/30',
            'text-pink-400 bg-pink-400/10 border-pink-400/30',
            'text-amber-400 bg-amber-400/10 border-amber-400/30',
            'text-cyan-400 bg-cyan-400/10 border-cyan-400/30',
            'text-emerald-400 bg-emerald-400/10 border-emerald-400/30',
            'text-indigo-400 bg-indigo-400/10 border-indigo-400/30'
        ];
        let hash = 0;
        for (let i = 0; i < (name || '').length; i++) {
            hash = (name.charCodeAt(i) + ((hash << 5) - hash)) % colors.length;
        }
        return colors[Math.abs(hash)];
    };

    return (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {segments.map((seg, i) => {
                const colorClass = getSpeakerColor(seg.speaker);
                return (
                    <div key={i} className="flex gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border ${colorClass.split(' ').slice(0, 3).join(' ')}`}>
                            {seg.speaker?.charAt(0) || '?'}
                        </div>
                        <div className="flex-1">
                            <div className="flex items-baseline gap-2 mb-1">
                                <span className={`font-bold text-sm ${colorClass.split(' ')[0]}`}>{seg.speaker}</span>
                                <span className="text-[10px] text-gray-500 font-mono tracking-tighter">{seg.time}</span>
                            </div>
                            <p className="text-gray-200 text-sm leading-relaxed bg-white/5 p-3 rounded-tr-xl rounded-br-xl rounded-bl-xl border border-white/5">
                                {seg.text}
                            </p>
                        </div>
                    </div>
                );
            })}
            <div ref={endRef} />
        </div>
    );
};


export default function MeetingAI() {
    const [meetings, setMeetings] = useState([]);
    const [selectedMeeting, setSelectedMeeting] = useState(null);
    const [selectedBot, setSelectedBot] = useState(null); // New state for live monitoring
    const [meetingContent, setMeetingContent] = useState(''); // Content for historical meetings
    const [view, setView] = useState('overview');
    const [chatMessages, setChatMessages] = useState([]);
    const [chatInput, setChatInput] = useState('');
    const [summary, setSummary] = useState(null);
    const [actionItems, setActionItems] = useState(null);
    const [status, setStatus] = useState('');
    const [theme, setTheme] = useState('dark');

    // UI Layout State
    const [showLogs, setShowLogs] = useState(true); // Default Visible for status monitoring

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

                // Sync selected bot with latest data (e.g., new transcript segments)
                if (selectedBot) {
                    const latest = bots.find(b => b.id === selectedBot.id);
                    if (latest) {
                        setSelectedBot(latest);
                    } else {
                        setSelectedBot(null);
                    }
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
        setSelectedMeeting(null);
        setView('overview'); // Switch to unified transcript view
    };

    useEffect(() => {
        if (selectedMeeting) {
            // Priority 1: Use transcript array if available (from MongoDB)
            if (selectedMeeting.transcript && Array.isArray(selectedMeeting.transcript) && selectedMeeting.transcript.length > 0) {
                setMeetingContent(selectedMeeting.transcript);
            }
            // Priority 2: Use file path if available (legacy/fallback)
            else if (selectedMeeting.path) {
                fetch(selectedMeeting.path)
                    .then(r => r.text())
                    .then(text => setMeetingContent(text))
                    .catch(e => console.error('Failed to load transcript file:', e));
            } else {
                setMeetingContent('');
            }
        } else {
            setMeetingContent('');
        }
    }, [selectedMeeting]);

    const toggleTheme = () => {
        const newTheme = theme === 'light' ? 'dark' : 'light';
        setTheme(newTheme);
        localStorage.setItem('theme', newTheme);
        document.documentElement.classList.toggle('dark', newTheme === 'dark');
    };

    return (
        <div className="flex flex-col h-screen bg-teams-bg text-teams-text-primary font-sans">
            {/* Header */}
            <header className="flex-shrink-0 bg-[#333366]/80 backdrop-blur-xl text-white h-14 px-6 flex items-center justify-between shadow-lg z-50 border-b border-white/10">
                <div className="flex items-center gap-3 text-xl font-bold tracking-tight">
                    <div className="p-1.5 rounded-lg shadow-inner bg-white/10">
                        <svg className="w-5 h-5 text-teams-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                        </svg>
                    </div>
                    <span className="bg-clip-text text-transparent bg-gradient-to-r from-white to-white/70">MeetingAI</span>
                </div>
                <div className="flex items-center gap-5 text-sm">
                    {/* Log Toggle */}
                    <button
                        onClick={() => setShowLogs(!showLogs)}
                        className={`text-[10px] font-mono px-3 py-1.5 rounded-full border transition-all duration-300 ${showLogs ? 'bg-white text-black border-white' : 'text-white/70 border-white/20 hover:border-white/50 hover:bg-white/5'}`}
                    >
                        &gt;_ TERMINAL
                    </button>

                    {status && <span className="opacity-80 text-xs italic animate-pulse">{status}</span>}

                    <button onClick={toggleTheme} className="p-2 rounded-full hover:bg-white/10 transition-colors" title="Toggle Theme">
                        {theme === 'light' ? (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                            </svg>
                        ) : (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                            </svg>
                        )}
                    </button>

                    {/* User Profile in Header */}
                    {isLoggedIn && userInfo ? (
                        <div className="flex items-center gap-3 bg-white/5 px-4 py-1.5 rounded-full border border-white/10 glass">
                            <div className="flex flex-col text-right leading-none">
                                <span className="text-xs font-bold text-white">{userInfo.displayName}</span>
                                <span className="text-[9px] text-green-400 font-bold uppercase tracking-widest mt-0.5">Connected</span>
                            </div>
                            <button
                                onClick={() => { document.cookie = 'ms_token=; Max-Age=0'; setIsLoggedIn(false); setUserInfo(null); }}
                                className="text-gray-400 hover:text-white transition-colors"
                                title="Disconnect"
                            >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                            </button>
                        </div>
                    ) : (
                        <a
                            href="/api/auth/login"
                            className="flex items-center gap-2 bg-[#444791] hover:bg-[#5b5fc7] px-4 py-1.5 rounded-md font-bold text-white transition-all shadow-md group"
                        >
                            <svg className="w-4 h-4 fill-white group-hover:scale-110 transition-transform" viewBox="0 0 24 24">
                                <path d="M11.4 24H0V12.6h11.4V24zM24 24H12.6V12.6H24V24zM11.4 11.4H0V0h11.4v11.4zM24 11.4H12.6V0H24v11.4z" />
                            </svg>
                            <span>Connect Teams</span>
                        </a>
                    )}
                </div>
            </header>

            <div className="flex flex-1 overflow-hidden">
                {/* Sidebar (Full Left) */}
                <div className="w-72 bg-teams-surface flex-shrink-0 flex flex-col border-r border-teams-border">

                    {/* --- NEW BOT ACTIONS SECTION --- */}
                    <div className="p-4 border-b border-teams-border bg-black/10">
                        <h3 className="text-xs uppercase font-bold text-teams-text-secondary mb-3 flex justify-between items-center">
                            <span>Bot Actions</span>
                            {isLoggedIn && (
                                <button onClick={loadActiveMeetings} className="hover:text-white" title="Refresh Active Meetings">
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                    </svg>
                                </button>
                            )}
                        </h3>

                        {/* 1. AUTO DETECT / JOIN CURRENT (Only if logged in) */}
                        {isLoggedIn && activeMeetings.find(m => m.isCurrent) && (
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
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    <span>Join &quot;{activeMeetings.find(m => m.isCurrent).subject}&quot;</span>
                                </button>
                            </div>
                        )}

                        {/* 2. MANUAL JOIN (Always show) */}
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
                                const createdDate = new Date(m.created);
                                const isRecent = createdDate > new Date(Date.now() - 24 * 60 * 60 * 1000);
                                return (
                                    <div
                                        key={m.filename}
                                        className={`group relative p-3 rounded-md cursor-pointer border-l-4 ${selectedMeeting?.filename === m.filename ? 'bg-black/20 border-teams-primary' : 'border-transparent hover:bg-white/5'}`}
                                        onClick={() => handleMeetingSelect(m)}
                                    >
                                        <div className="flex items-center gap-2 mb-1">
                                            <div className="text-teams-primary">
                                                {m.meetingId === 'Manual Recording' ? (
                                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                                    </svg>
                                                ) : (
                                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                                    </svg>
                                                )}
                                            </div>
                                            <h4 className="font-semibold truncate text-sm text-teams-text-primary">
                                                {m.meetingId === 'Manual Recording' ? 'Manual Meeting' : `${m.meetingId}`}
                                            </h4>
                                            {isRecent && <span className="text-[9px] bg-teams-primary/20 text-teams-primary px-1 rounded-sm font-bold border border-teams-primary/30">NEW</span>}
                                        </div>
                                        <p className="text-xs text-teams-text-secondary flex justify-between">
                                            <span>{createdDate.toLocaleDateString()} {createdDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                            <span className="opacity-70">{(m.size / 1024).toFixed(1)} KB</span>
                                        </p>

                                    </div>
                                );
                            })}
                        </div>
                    </div>
                    <div className="p-4 border-t border-teams-border">
                        <input id="file-upload" type="file" onChange={doUpload} accept=".vtt" className="hidden" />
                        <button className="w-full bg-white/10 hover:bg-white/20 text-teams-text-primary font-semibold py-2 px-4 rounded-md text-sm flex items-center justify-center gap-2"
                            onClick={() => document.getElementById('file-upload').click()}>
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                            </svg>
                            <span>Upload VTT</span>
                        </button>
                    </div>
                </div>

                {/* Main Content (Center) */}
                <main className="flex-1 flex flex-col bg-teams-bg overflow-hidden relative">
                    {selectedBot || selectedMeeting ? (
                        <>
                            {/* Unified Stage Header */}
                            <div className="flex-shrink-0 p-6 border-b border-teams-border bg-teams-surface relative overflow-hidden">
                                {selectedBot && <div className="absolute top-0 left-0 w-full h-0.5 premium-gradient-animate opacity-50" />}

                                <div className="flex justify-between items-start">
                                    <div>
                                        <div className="flex items-center gap-2 mb-1">
                                            <h2 className="text-2xl font-black tracking-tight text-white">
                                                {selectedBot ? (selectedBot.metadata?.subject || 'Live Recording') : selectedMeeting.meetingId}
                                            </h2>
                                            {selectedBot ? (
                                                <span className="px-2 py-0.5 rounded bg-red-500/20 text-red-400 text-[10px] font-black uppercase tracking-widest border border-red-500/30 animate-pulse">
                                                    Live
                                                </span>
                                            ) : (
                                                <span className="px-2 py-0.5 rounded bg-teams-primary/20 text-teams-primary text-[10px] font-bold uppercase tracking-widest border border-teams-primary/30">
                                                    Archived
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs text-teams-text-secondary">
                                            {selectedBot ? `Session ID: ${selectedBot.id.substring(0, 8)}...` : `Source: ${selectedMeeting.source} | Duration: ${selectedMeeting.durationSeconds || 'Unknown'}s`}
                                        </p>
                                    </div>

                                    {selectedBot && (
                                        <div className="flex items-center gap-3 bg-white/5 px-4 py-2 rounded-xl border border-white/10">
                                            <div className="flex gap-1">
                                                <div className="w-1 h-4 bg-green-500 animate-pulse" />
                                                <div className="w-1 h-3 bg-green-500/60 animate-pulse delay-75" />
                                                <div className="w-1 h-4 bg-green-500/80 animate-pulse delay-150" />
                                            </div>
                                            <span className="text-xs font-bold text-green-400 font-mono">{selectedBot.status}</span>
                                        </div>
                                    )}
                                </div>

                                <div className="mt-4 flex gap-6 border-b border-teams-border">
                                    <button onClick={() => setView('overview')} className={`py-2 text-sm font-semibold border-b-2 transition-all ${view === 'overview' ? 'text-teams-primary border-teams-primary' : 'text-teams-text-secondary border-transparent hover:text-white'}`}>
                                        Transcript
                                    </button>

                                    {/* Locked tabs for live sessions */}
                                    {['summary', 'actions', 'chat'].map(tab => {
                                        const isLocked = !!selectedBot;
                                        const labels = { summary: 'AI Summary', actions: 'Action Items', chat: 'Chat' };
                                        return (
                                            <button
                                                key={tab}
                                                disabled={isLocked}
                                                onClick={() => { setView(tab); if (tab === 'summary') getSummary(); if (tab === 'actions') getActions(); }}
                                                className={`py-2 text-sm font-semibold border-b-2 transition-all relative group
                                                    ${view === tab ? 'text-teams-primary border-teams-primary' : 'text-teams-text-secondary border-transparent hover:text-white'}
                                                    ${isLocked ? 'opacity-30 cursor-not-allowed' : ''}`}
                                            >
                                                {labels[tab]}
                                                {isLocked && (
                                                    <span className="absolute -top-1 -right-2 text-[8px] bg-gray-700 text-gray-400 px-1 rounded border border-gray-600 opacity-0 group-hover:opacity-100 transition-opacity">
                                                        Wait for end
                                                    </span>
                                                )}
                                            </button>
                                        );
                                    })}

                                    {selectedBot && (
                                        <button onClick={() => setView('logs')} className={`py-2 text-sm font-semibold border-b-2 transition-all ${view === 'logs' ? 'text-teams-primary border-teams-primary' : 'text-teams-text-secondary border-transparent hover:text-white'}`}>
                                            Bot Logs
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Stage Content */}
                            <div className="flex-1 overflow-hidden p-6 relative">
                                {view === 'overview' && (
                                    <div className="h-full flex flex-col bg-teams-surface rounded-2xl shadow-xl border border-teams-border overflow-hidden glass">
                                        <div className="p-4 border-b border-teams-border flex justify-between items-center bg-black/20">
                                            <h3 className="text-sm uppercase font-black tracking-widest text-white/80">
                                                {selectedBot ? 'Real-Time Voice Streaming' : 'Full Meeting Transcript'}
                                            </h3>
                                            {!selectedBot && (
                                                <button
                                                    className="text-[10px] bg-teams-primary hover:bg-teams-secondary px-3 py-1 rounded text-white font-bold transition-all flex items-center gap-1 shadow-lg"
                                                    onClick={() => {
                                                        const blob = new Blob([meetingContent], { type: 'text/vtt' });
                                                        const url = URL.createObjectURL(blob);
                                                        const a = document.createElement('a');
                                                        a.href = url;
                                                        a.download = selectedMeeting.filename || 'transcript.vtt';
                                                        a.click();
                                                    }}
                                                >
                                                    <span>DOWNLOAD VTT</span>
                                                </button>
                                            )}
                                        </div>
                                        <LiveTranscript vttContent={selectedBot ? (selectedBot.transcriptSegments || []) : meetingContent} />
                                    </div>
                                )}

                                {(view === 'summary' || view === 'actions') && !selectedBot && (
                                    <div className="bg-teams-surface rounded-2xl shadow-xl p-8 border border-teams-border glass h-full overflow-y-auto">
                                        {(view === 'summary' && !summary) || (view === 'actions' && !actionItems) ? (
                                            <div className="flex items-center justify-center h-full gap-3 text-teams-text-secondary">
                                                <div className="w-6 h-6 border-4 border-teams-primary border-t-transparent rounded-full animate-spin" />
                                                <span className="font-bold uppercase tracking-widest text-xs">Generating AI Content...</span>
                                            </div>
                                        ) : view === 'summary' ? (
                                            summary.error ? <p className="text-red-400">Error: {summary.error}</p> :
                                                <div className="prose prose-invert max-w-none">
                                                    <div className="bg-white/5 p-6 rounded-2xl border border-white/10 leading-loose text-gray-200"
                                                        dangerouslySetInnerHTML={{ __html: summary.summary.replace(/\n/g, '<br/>') }}
                                                    />
                                                </div>
                                        ) : (
                                            actionItems.error ? <p className="text-red-400">Error: {actionItems.error}</p> : (
                                                <div className="space-y-4">
                                                    <h4 className="text-sm font-black text-teams-primary uppercase tracking-widest mb-6">Identified Action Items</h4>
                                                    <table className="w-full text-sm text-left">
                                                        <thead className="text-gray-500 uppercase text-[10px] font-black tracking-widest">
                                                            <tr className="border-b border-teams-border">
                                                                <th className="pb-4 px-2">Task Description</th>
                                                                <th className="pb-4 px-2 w-40">Owner</th>
                                                                <th className="pb-4 px-2 w-24">Priority</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-white/5">
                                                            {actionItems.actionItems?.map((item, i) => (
                                                                <tr key={i} className="hover:bg-white/5 transition-colors group">
                                                                    <td className="py-4 px-2 text-gray-100 font-medium">{item.task}</td>
                                                                    <td className="py-4 px-2">
                                                                        <span className="bg-teams-primary/20 text-teams-primary px-3 py-1 rounded-full text-[10px] font-black border border-teams-primary/30">
                                                                            {item.owner}
                                                                        </span>
                                                                    </td>
                                                                    <td className="py-4 px-2">
                                                                        <span className={`text-[10px] font-black px-2 py-0.5 rounded ${item.priority?.toLowerCase().includes('high') ? 'bg-red-500 text-white' : 'bg-gray-700 text-gray-300'}`}>
                                                                            {item.priority?.toUpperCase()}
                                                                        </span>
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            )
                                        )}
                                    </div>
                                )}

                                {view === 'chat' && !selectedBot && (
                                    <div className="flex flex-col h-full bg-teams-surface rounded-2xl shadow-xl border border-teams-border overflow-hidden glass">
                                        <div className="flex-1 overflow-y-auto p-6 space-y-6">
                                            {chatMessages.length === 0 && (
                                                <div className="flex flex-col items-center justify-center h-full text-center space-y-4 opacity-50">
                                                    <div className="text-teams-primary p-4 bg-white/5 rounded-full mb-2">
                                                        <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                                                        </svg>
                                                    </div>
                                                    <p className="text-sm font-bold uppercase tracking-widest">Ask anything about this meeting</p>
                                                </div>
                                            )}
                                            {chatMessages.map((m, i) => (
                                                <div key={i} className={`flex gap-4 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                                    <div className={`max-w-[80%] p-4 rounded-2xl shadow-lg border ${m.role === 'user' ? 'bg-teams-primary text-white border-white/10' : 'bg-black/40 text-gray-200 border-white/5'}`}>
                                                        <p className="text-sm leading-relaxed whitespace-pre-wrap">{m.content}</p>
                                                        {m.sources && (
                                                            <div className="mt-4 pt-3 border-t border-white/10 space-y-2">
                                                                <span className="text-[9px] font-black text-teams-primary uppercase tracking-widest">Sources Found</span>
                                                                {m.sources.map((s, si) => (
                                                                    <div key={si} className="p-2 bg-black/30 rounded-lg text-[10px] italic border border-white/5 text-gray-400">
                                                                        &quot;{s.text.substring(0, 150)}...&quot;
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                            <div ref={chatEndRef} />
                                        </div>
                                        <div className="p-4 bg-black/20 border-t border-teams-border flex gap-3">
                                            <input
                                                type="text"
                                                value={chatInput}
                                                onChange={e => setChatInput(e.target.value)}
                                                onKeyDown={e => e.key === 'Enter' && sendChat()}
                                                placeholder="Ask a question..."
                                                className="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-teams-primary/50 transition-all placeholder:text-gray-600"
                                            />
                                            <button onClick={sendChat} className="bg-teams-primary hover:bg-teams-secondary text-white font-black uppercase text-[10px] tracking-widest px-6 py-3 rounded-xl transition-all shadow-lg active:scale-95">
                                                Send
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {view === 'logs' && selectedBot && (
                                    <div className="h-full bg-black/60 rounded-2xl p-6 font-mono text-[11px] overflow-hidden flex flex-col border border-white/10 shadow-2xl glass">
                                        <div className="flex items-center justify-between mb-4 border-b border-white/10 pb-3">
                                            <h3 className="text-xs uppercase font-black text-white/40 tracking-widest">Internal Bot Operations</h3>
                                            <span className="text-[9px] bg-green-500/10 text-green-500 px-2 py-0.5 rounded border border-green-500/20">AGENT LOGS</span>
                                        </div>
                                        <div className="flex-1 overflow-y-auto scrollbar-hide">
                                            <LogViewer logId={selectedBot.id} contained={true} />
                                        </div>
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="flex flex-col items-center justify-center h-full text-center px-6">
                            {/* ACTIVE BOTS "HAPPENING NOW" SECTION */}
                            {activeBots.length > 0 ? (
                                <div className="max-w-4xl w-full">
                                    <div className="flex items-center justify-center gap-3 mb-8">
                                        <span className="w-3 h-3 bg-red-500 rounded-full animate-ping" />
                                        <h2 className="text-3xl font-black uppercase tracking-tighter text-white">Happening Now</h2>
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full">
                                        {activeBots.map(bot => (
                                            <div
                                                key={bot.id}
                                                onClick={() => handleBotSelect(bot)}
                                                className="group relative bg-teams-surface border border-white/10 rounded-3xl p-8 cursor-pointer hover:border-teams-primary/50 hover:scale-[1.02] transition-all shadow-2xl glass-dark active-bot-card overflow-hidden"
                                            >
                                                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-red-500 to-amber-500 opacity-50 group-hover:opacity-100 transition-opacity" />

                                                <div className="flex items-start justify-between mb-6">
                                                    <div className="text-left">
                                                        <h3 className="text-xl font-black text-white group-hover:text-teams-primary transition-colors mb-1">
                                                            {bot.metadata?.subject || 'Untitled Meeting'}
                                                        </h3>
                                                        <span className="text-[10px] font-mono text-gray-500">SESSION: {bot.id.substring(0, 12)}</span>
                                                    </div>
                                                    <div className="bg-red-500/10 border border-red-500/20 px-3 py-1 rounded-full">
                                                        <div className="flex items-center gap-2">
                                                            <div className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
                                                            <span className="text-[9px] font-black text-red-500 uppercase tracking-widest">Recording</span>
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-4 py-4 px-6 bg-white/5 rounded-2xl border border-white/5 mb-6 group-hover:bg-white/10 transition-all">
                                                    <div className="flex gap-1.5">
                                                        <div className="w-1.5 h-8 bg-teams-primary animate-pulse" />
                                                        <div className="w-1.5 h-5 bg-teams-primary/60 animate-pulse delay-75" />
                                                        <div className="w-1.5 h-6 bg-teams-primary/80 animate-pulse delay-150" />
                                                    </div>
                                                    <div className="text-left">
                                                        <p className="text-[10px] uppercase font-black text-gray-500 tracking-widest mb-0.5">Current Speaker</p>
                                                        <p className="text-sm font-bold text-white leading-none">{bot.currentSpeaker || 'Listening...'}</p>
                                                    </div>
                                                </div>

                                                <button className="w-full bg-teams-primary py-4 rounded-xl font-black text-xs uppercase tracking-[0.2em] text-white shadow-xl group-hover:bg-teams-secondary transition-all">
                                                    Watch Live Stream
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="mt-12 pt-12 border-t border-white/5 w-64 mx-auto">
                                        <p className="text-[10px] font-black text-gray-700 uppercase tracking-widest mb-4">Or Select From History</p>
                                        <div className="text-teams-primary/20 flex justify-center">
                                            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-6">
                                    <div className="text-teams-primary mb-4 animate-bounce flex justify-center">
                                        <svg className="w-16 h-16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
                                        </svg>
                                    </div>
                                    <h3 className="text-3xl font-black tracking-tighter text-teams-text-primary uppercase">Select a meeting</h3>
                                    <p className="max-w-sm text-teams-text-secondary leading-relaxed mx-auto text-lg opacity-80">
                                        Join an active session above or browse your archived transcripts in the library sidebar.
                                    </p>

                                    {!isLoggedIn && (
                                        <div className="pt-8">
                                            <a
                                                href="/api/auth/login"
                                                className="flex items-center gap-4 bg-gradient-to-r from-[#444791] to-[#5b5fc7] px-12 py-5 rounded-2xl font-black text-xl text-white transition-all shadow-[0_20px_50px_rgba(68,71,145,0.4)] hover:scale-105 active:scale-95 group border border-white/10"
                                            >
                                                <svg className="w-8 h-8 fill-white group-hover:rotate-12 transition-transform" viewBox="0 0 24 24">
                                                    <path d="M11.4 24H0V12.6h11.4V24zM24 24H12.6V12.6H24V24zM11.4 11.4H0V0h11.4v11.4zM24 11.4H12.6V0H24v11.4z" />
                                                </svg>
                                                <span>Connect Teams Workspace</span>
                                            </a>
                                            <p className="mt-6 text-xs text-gray-500 font-bold uppercase tracking-widest opacity-50 italic">
                                                * Cloud ingestion requires organizational access
                                            </p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                </main>

                {/* Right Log Panel */}
                {showLogs && <LogViewer onClose={() => setShowLogs(false)} logId={activeLogId} />}
            </div>
        </div>
    );
}