'use client';

import React, { useState, useEffect, useRef } from 'react';

const Spinner = () => (
    <svg className="animate-spin h-5 w-5 text-teams-secondary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
);

export default function MeetingAI() {
    const [meetings, setMeetings] = useState([]);
    const [realMeetings, setRealMeetings] = useState([]);
    const [selectedMeeting, setSelectedMeeting] = useState(null);
    const [view, setView] = useState('overview'); // overview, summary, actions, chat
    const [status, setStatus] = useState('');
    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [userInfo, setUserInfo] = useState(null);
    const [theme, setTheme] = useState('dark');

    // AI States
    const [summary, setSummary] = useState(null);
    const [actionItems, setActionItems] = useState(null);
    const [chatMessages, setChatMessages] = useState([]);
    const [chatInput, setChatInput] = useState('');
    const chatEndRef = useRef(null);

    useEffect(() => {
        checkLogin();
        loadMeetings();
        const savedTheme = localStorage.getItem('theme') || 'dark';
        setTheme(savedTheme);
        document.documentElement.classList.toggle('dark', savedTheme === 'dark');
    }, []);

    useEffect(() => {
        if (isLoggedIn) {
            loadRealMeetings();
            loadUserInfo();
        }
    }, [isLoggedIn]);

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatMessages]);

    async function checkLogin() {
        const hasToken = document.cookie.includes('ms_token=');
        setIsLoggedIn(hasToken);
    }

    async function loadUserInfo() {
        try {
            const res = await fetch('/api/user/info');
            if (res.ok) setUserInfo(await res.json());
        } catch (e) { console.error(e); }
    }

    async function loadMeetings() {
        try {
            const res = await fetch('/api/transcripts');
            const data = await res.json();
            setMeetings(data || []);
        } catch (error) {
            console.error('Error loading meetings:', error);
            setStatus('Failed to load meetings.');
        }
    }

    async function loadRealMeetings() {
        setStatus('Syncing Teams recordings...');
        try {
            const res = await fetch('/api/teams/recent');
            if (res.ok) {
                const data = await res.json();
                setRealMeetings(data || []);
                console.log(`Loaded ${data.length} real meetings`);
            } else {
                setRealMeetings([]);
            }
        } catch (e) {
            console.error(e);
            setStatus('Network error syncing meetings.');
        } finally {
            setStatus('');
        }
    }

    async function autoSync() {
        setStatus('Auto-syncing all meetings...');
        try {
            const res = await fetch('/api/sync');
            const data = await res.json();
            if (data.success) {
                await loadMeetings();
                await loadRealMeetings();
                setStatus(`Sync complete: ${data.summary.newIngested} new meetings ingested.`);
            } else {
                setStatus(`Sync error: ${data.error}`);
            }
        } catch (e) {
            console.error(e);
            setStatus('Network error during sync.');
        }
        setTimeout(() => setStatus(''), 5000);
    }

    async function ingestMeeting(meeting) {
        setStatus(`Ingesting ${meeting.subject}...`);
        try {
            const token = document.cookie.split('ms_token=')[1]?.split(';')[0];
            const res = await fetch('/api/ingest/teams', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    accessToken: token,
                    teamsMeetingId: meeting.driveItemId || meeting.id,
                    meetingData: meeting
                })
            });
            const data = await res.json();
            if (res.ok) {
                setStatus('Ingestion successful!');
                loadMeetings();
                loadRealMeetings(); // Refresh list to remove ingested item
            } else {
                setStatus(`Error: ${data.error}`);
                // If error is related to transcript, suggest VTT upload
                if (data.error?.includes('Transcript') || data.error?.includes('404')) {
                    alert('Automatic transcript fetch failed. Please use the "Attach VTT" button to upload the transcript manually.');
                }
            }
        } catch (error) {
            setStatus(`Network error: ${error.message}`);
        }
    }


    async function doUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        setStatus('Uploading VTT...');
        const reader = new FileReader();
        reader.onload = async (event) => {
            const content = event.target.result;
            try {
                const res = await fetch('/api/upload', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content, filename: file.name })
                });
                const data = await res.json();
                if (data.success) {
                    setStatus('Upload success!');
                    loadMeetings();
                } else {
                    setStatus(`Upload error: ${data.error}`);
                }
            } catch (error) {
                setStatus('Network error during upload.');
            }
            setTimeout(() => setStatus(''), 3000);
        };
        reader.readAsText(file);
    }

    async function handleDeleteMeeting(id) {
        if (!confirm('Are you sure you want to delete this meeting?')) return;
        setStatus('Deleting...');
        try {
            const res = await fetch(`/api/transcripts?id=${id}`, { method: 'DELETE' });
            if (res.ok) {
                loadMeetings();
                if (selectedMeeting?.meetingId === id) setSelectedMeeting(null);
            }
        } catch (e) { console.error(e); }
        setStatus('');
    }

    async function getSummary() {
        if (!selectedMeeting) return;
        setSummary(null);
        try {
            const res = await fetch(`/api/summarize?id=${selectedMeeting.meetingId}`);
            setSummary(await res.json());
        } catch (e) { setSummary({ error: 'Failed' }); }
    }

    async function getActions() {
        if (!selectedMeeting) return;
        setActionItems(null);
        try {
            const res = await fetch(`/api/actions?id=${selectedMeeting.meetingId}`);
            setActionItems(await res.json());
        } catch (e) { setActionItems({ error: 'Failed' }); }
    }

    async function sendChat() {
        if (!chatInput.trim() || !selectedMeeting) return;
        const userMsg = chatInput;
        setChatInput('');
        const newMessages = [...chatMessages, { role: 'user', content: userMsg }];
        setChatMessages(newMessages);
        setStatus('AI is thinking...');

        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ meetingId: selectedMeeting.meetingId, message: userMsg, history: chatMessages })
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
        setView('overview');
        setChatMessages([]);
        setSummary(null);
        setActionItems(null);
    };

    const toggleTheme = () => {
        const newTheme = theme === 'light' ? 'dark' : 'light';
        setTheme(newTheme);
        localStorage.setItem('theme', newTheme);
        document.documentElement.classList.toggle('dark', newTheme === 'dark');
    };

    return (
        <div className="flex flex-col h-screen bg-teams-bg text-teams-text-primary font-sans">
            <header className="flex-shrink-0 bg-[#333366] text-white h-12 px-4 flex items-center justify-between shadow-md">
                <div className="flex items-center gap-2 text-lg font-semibold">
                    <span>⌯</span> MeetingAI
                </div>
                <div className="flex items-center gap-4 text-sm">
                    {status && <span className="opacity-80">{status}</span>}
                    <button onClick={toggleTheme} className="p-2 rounded-full hover:bg-white/10" title="Toggle Theme">
                        {theme === 'light' ? '🌙' : '☀️'}
                    </button>
                    <button onClick={() => window.location.reload()} className="p-2 rounded-full hover:bg-white/10" title="Reload Dashboard">
                        ↻
                    </button>
                </div>
            </header>

            <div className="flex flex-1 overflow-hidden">
                <div className="w-80 bg-teams-surface flex-shrink-0 flex flex-col border-r border-teams-border">
                    {/* Teams Connection Section */}
                    <div className="p-4 border-b border-teams-border space-y-3">
                        {!isLoggedIn ? (
                            <button
                                onClick={() => window.location.href = '/api/auth/login?prompt=select_account'}
                                className="w-full bg-teams-primary hover:bg-teams-secondary text-white font-semibold py-2 px-4 rounded-md text-sm transition-colors shadow-lg"
                            >
                                Connect to Microsoft Teams
                            </button>
                        ) : (
                            <div className="space-y-3">
                                <div className="flex justify-between items-center text-xs">
                                    <span className="text-green-400 font-bold flex items-center gap-1">● Online</span>
                                    <button
                                        onClick={() => { document.cookie = 'ms_token=; Max-Age=0'; window.location.reload(); }}
                                        className="text-teams-text-secondary hover:text-white underline"
                                    >
                                        Disconnect
                                    </button>
                                </div>
                                <button
                                    onClick={autoSync}
                                    className="w-full bg-teams-accent text-white font-bold py-2 rounded-md text-sm shadow-md hover:brightness-110 active:scale-95 transition-all"
                                >
                                    ⚡ Auto-Sync & Ingest Everything
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Discovery Section */}
                    <div className="p-4 border-b border-teams-border bg-black/5">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-[10px] uppercase font-bold text-teams-text-secondary tracking-widest">Discovered Content</h3>
                            <button onClick={loadRealMeetings} className="text-[10px] text-teams-accent hover:underline">Refresh</button>
                        </div>
                        <div className="max-h-64 overflow-y-auto space-y-2">
                            {realMeetings.length > 0 ? realMeetings.map((rm) => (
                                <div key={rm.id || rm.webUrl} className="p-2 rounded bg-white/5 border border-white/5 group relative hover:bg-white/10 transition-colors">
                                    <p className="text-xs font-medium text-white/90 truncate pr-12" title={rm.subject}>{rm.subject}</p>
                                    <p className="text-[9px] text-teams-text-secondary mt-1">
                                        {new Date(rm.start).toLocaleDateString()} • {rm.isVttFile ? 'VTT' : 'MP4'}
                                    </p>
                                    <div className="absolute top-1.5 right-1.5 flex gap-1">
                                        {rm.status === 'READY' ? (
                                            <button
                                                onClick={() => ingestMeeting(rm)}
                                                className="bg-teams-secondary text-white text-[9px] px-2 py-0.5 rounded font-bold shadow-sm"
                                            >
                                                Ingest
                                            </button>
                                        ) : (
                                            <a href={rm.webUrl} target="_blank" rel="noopener noreferrer" className="text-[9px] text-teams-accent hover:underline">View ↗</a>
                                        )}
                                    </div>
                                </div>
                            )) : (
                                <div className="text-[10px] text-center py-4 text-teams-text-secondary/50 border border-dashed border-white/10 rounded">
                                    No recordings found yet.
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Ingested List */}
                    <div className="flex-1 flex flex-col overflow-hidden">
                        <h3 className="p-4 pb-2 text-[10px] uppercase font-bold text-teams-text-secondary tracking-widest">Ingested Meetings</h3>
                        <div className="flex-1 overflow-y-auto px-2 space-y-1">
                            {meetings.length === 0 && <div className="px-2 py-8 text-xs text-center text-teams-text-secondary/50">Nothing ingested yet.</div>}
                            {meetings.map(m => (
                                <div
                                    key={m.meetingId}
                                    className={`group relative p-3 rounded-md cursor-pointer border-l-4 transition-all ${selectedMeeting?.meetingId === m.meetingId ? 'bg-teams-primary/20 border-teams-primary shadow-inner' : 'border-transparent hover:bg-white/5'}`}
                                    onClick={() => handleMeetingSelect(m)}
                                >
                                    <h4 className="font-semibold truncate text-xs text-white/90">{m.meetingId}</h4>
                                    <p className="text-[10px] text-teams-text-secondary mt-1">{m.source} • {new Date(m.importedAt).toLocaleDateString()}</p>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); handleDeleteMeeting(m.meetingId); }}
                                        className="absolute top-3 right-2 text-teams-text-secondary hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                    >
                                        ✘
                                    </button>
                                </div>
                            ))}
                        </div>
                        <div className="p-4 border-t border-teams-border">
                            <button className="w-full border border-white/10 hover:bg-white/5 text-teams-text-secondary py-2 rounded-md text-[11px] font-medium transition-all"
                                onClick={() => document.getElementById('file-upload').click()}>
                                Upload Local VTT
                            </button>
                            <input id="file-upload" type="file" onChange={doUpload} accept=".vtt" className="hidden" />
                        </div>
                    </div>
                </div>

                {/* Main Content Area */}
                <main className="flex-1 flex flex-col bg-teams-bg overflow-hidden relative">
                    {selectedMeeting ? (
                        <>
                            <div className="flex-shrink-0 p-6 border-b border-teams-border bg-teams-surface/50 backdrop-blur-md sticky top-0 z-10">
                                <h2 className="text-2xl font-bold text-white mb-1">{selectedMeeting.meetingId}</h2>
                                <p className="text-xs text-teams-text-secondary">
                                    {selectedMeeting.source} • {selectedMeeting.durationSeconds || 0} seconds
                                </p>
                                <div className="mt-6 flex gap-6">
                                    {[
                                        { id: 'overview', label: 'Transcript' },
                                        { id: 'summary', label: 'AI Summary', action: getSummary },
                                        { id: 'actions', label: 'Action Items', action: getActions },
                                        { id: 'chat', label: 'Coffee Chat' }
                                    ].map(tab => (
                                        <button
                                            key={tab.id}
                                            onClick={() => { setView(tab.id); tab.action && tab.action(); }}
                                            className={`pb-2 text-sm font-bold border-b-2 transition-all ${view === tab.id ? 'text-teams-accent border-teams-accent' : 'text-teams-text-secondary border-transparent hover:text-white/80'}`}
                                        >
                                            {tab.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="flex-1 overflow-y-auto p-6 scroll-smooth">
                                {view === 'overview' && (
                                    <div className="max-w-4xl mx-auto space-y-6">
                                        {selectedMeeting.entries?.map((e, i) => (
                                            <div key={i} className="flex gap-6 items-start group">
                                                <div className="w-24 shrink-0 text-[11px] font-bold text-teams-accent uppercase tracking-tighter pt-1 opacity-70">{e.speaker}</div>
                                                <div className="flex-1 text-sm bg-white/5 p-3 rounded-lg border border-white/5 hover:border-white/10 transition-all text-white/90 leading-relaxed">{e.text}</div>
                                                <div className="w-16 shrink-0 text-[10px] text-teams-text-secondary/50 pt-1 font-mono">{e.start}</div>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {(view === 'summary' || view === 'actions') && (
                                    <div className="max-w-4xl mx-auto bg-teams-surface p-8 rounded-xl shadow-2xl border border-white/5 animate-in fade-in slide-in-from-bottom-2">
                                        {(view === 'summary' && !summary) || (view === 'actions' && !actionItems) ? (
                                            <div className="flex flex-col items-center py-12 gap-4">
                                                <Spinner />
                                                <span className="text-sm text-teams-text-secondary animate-pulse">Running AI Analysis...</span>
                                            </div>
                                        ) : view === 'summary' ? (
                                            <div className="prose prose-invert max-w-none prose-sm leading-relaxed"
                                                dangerouslySetInnerHTML={{ __html: summary.error ? `Error: ${summary.error}` : summary.summary.replace(/\n/g, '<br/>') }} />
                                        ) : (
                                            <div className="overflow-hidden rounded-lg border border-white/10">
                                                <table className="w-full text-sm text-left">
                                                    <thead className="bg-white/5 text-teams-text-secondary">
                                                        <tr>
                                                            <th className="p-4 font-bold uppercase text-[10px]">What needs to be done?</th>
                                                            <th className="p-4 font-bold uppercase text-[10px] w-48">Owner</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody className="divide-y divide-white/10">
                                                        {(actionItems.actionItems || []).map((item, i) => (
                                                            <tr key={i} className="hover:bg-white/5 transition-colors">
                                                                <td className="p-4 text-white/90">{item.task}</td>
                                                                <td className="p-4"><span className="bg-teams-accent/20 text-teams-accent px-2 py-1 rounded text-[10px] font-bold">{item.owner}</span></td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {view === 'chat' && (
                                    <div className="flex flex-col h-full max-w-4xl mx-auto border border-white/10 rounded-xl overflow-hidden bg-teams-surface shadow-2xl">
                                        <div className="flex-1 overflow-y-auto p-6 space-y-6">
                                            {chatMessages.length === 0 && (
                                                <div className="h-full flex flex-col items-center justify-center opacity-30 select-none">
                                                    <div className="text-4xl mb-4 text-teams-primary">☕︎</div>
                                                    <p className="text-sm font-medium">Ask me anything about this meeting.</p>
                                                </div>
                                            )}
                                            {chatMessages.map((m, i) => (
                                                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                                    <div className={`max-w-[85%] p-4 rounded-2xl shadow-sm leading-relaxed ${m.role === 'user' ? 'bg-teams-primary text-white rounded-tr-none' : 'bg-white/5 text-white/90 border border-white/10 rounded-tl-none'}`}>
                                                        <p className="text-sm whitespace-pre-wrap">{m.content}</p>
                                                        {m.sources && (
                                                            <div className="mt-4 pt-3 border-t border-white/10 flex flex-col gap-2">
                                                                {m.sources.slice(0, 2).map((s, si) => (
                                                                    <div key={si} className="text-[10px] text-teams-text-secondary italic line-clamp-2">“{s.text}”</div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                            <div ref={chatEndRef} />
                                        </div>
                                        <div className="p-4 bg-black/20 border-t border-white/10 flex gap-3">
                                            <input
                                                type="text"
                                                value={chatInput}
                                                onChange={e => setChatInput(e.target.value)}
                                                onKeyDown={e => e.key === 'Enter' && sendChat()}
                                                placeholder="Ask about specific moments or decisions..."
                                                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-teams-accent transition-all text-white"
                                            />
                                            <button
                                                onClick={sendChat}
                                                disabled={!chatInput.trim()}
                                                className="bg-teams-accent hover:brightness-110 disabled:opacity-50 text-white p-3 rounded-lg transition-all"
                                            >
                                                ➔
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="flex flex-col items-center justify-center h-full text-center p-12 select-none">
                            <div className="text-[120px] mb-8 opacity-5 grayscale pointer-events-none">⌬</div>
                            <h3 className="text-2xl font-light text-white/50 mb-2">Ready to analyze</h3>
                            <p className="max-w-xs text-sm text-teams-text-secondary/60 leading-relaxed font-light">
                                Select an ingested meeting from the sidebar to start chat or generate a summary.
                            </p>
                        </div>
                    )}
                </main>
            </div>
        </div>
    );
}