import React, { useState, useEffect, useRef } from 'react';

// --- Helper to load scripts dynamically ---
const loadScript = (src) => {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.crossOrigin = 'anonymous';
        script.onload = () => resolve(script);
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    });
};

// --- SVG Icon Components ---
const PlayIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>;
const StopIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>;
const SoundWaveIcon = () => (
    <div className="flex items-center justify-center space-x-1">
        <span className="w-1 h-2 bg-cyan-400 rounded-full animate-[soundwave_1s_infinite_ease-in-out_0.1s]"></span>
        <span className="w-1 h-4 bg-cyan-400 rounded-full animate-[soundwave_1s_infinite_ease-in-out_0.3s]"></span>
        <span className="w-1 h-3 bg-cyan-400 rounded-full animate-[soundwave_1s_infinite_ease-in-out_0.5s]"></span>
    </div>
);

// --- Toast Notification Component ---
const Toast = ({ message, type, onDismiss }) => {
    useEffect(() => {
        const timer = setTimeout(onDismiss, 5000);
        return () => clearTimeout(timer);
    }, [onDismiss]);
    const bgColor = type === 'error' ? 'bg-red-500/80' : 'bg-yellow-500/80';
    return (
        <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-xl shadow-lg text-white font-semibold backdrop-blur-lg border border-white/20 ${bgColor}`}>
            {message}
        </div>
    );
};


const App = () => {
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const wsRef = useRef(null);
    const sequenceRef = useRef([]);
    const recordingStateRef = useRef({
        isRecording: false,
        mode: 'auto',
        startTimeout: null,
        stopTimeout: null,
        tone: 'Casual',
    });
    const subtitleTimeoutRef = useRef(null);


    const [status, setStatus] = useState('Connecting...');
    const [loading, setLoading] = useState(true);
    const [scriptsLoaded, setScriptsLoaded] = useState(false);
    const [uiMode, setUiMode] = useState('auto');
    const [conversationTone, setConversationTone] = useState('Casual');
    const [detectedTone, setDetectedTone] = useState('N/A');
    const [isPlayingAudio, setIsPlayingAudio] = useState(false);
    const [notification, setNotification] = useState(null);
    const [subtitleText, setSubtitleText] = useState('');

    // --- Load MediaPipe scripts ---
    useEffect(() => {
        const loadMediaPipeScripts = async () => {
            try {
                await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/holistic/holistic.js');
                await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js');
                await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');
                setScriptsLoaded(true);
            } catch (error) {
                console.error('Failed to load MediaPipe scripts:', error);
                setStatus('Error: Could not load AI models.');
                setLoading(false);
            }
        };
        loadMediaPipeScripts();
    }, []);

    // --- WebSocket connection ---
    useEffect(() => {
        const connectWebSocket = () => {
            wsRef.current = new WebSocket('ws://localhost:8080');
            wsRef.current.onopen = () => setStatus('Connected');
            wsRef.current.onmessage = (event) => {
                const data = JSON.parse(event.data);
                setNotification(null);
                if (data.audioData && data.sentence) {
                    const audioSrc = `data:audio/wav;base64,${data.audioData}`;
                    const audio = new Audio(audioSrc);
                    setIsPlayingAudio(true);
                    setSubtitleText(data.sentence);
                    
                    if (subtitleTimeoutRef.current) {
                        clearTimeout(subtitleTimeoutRef.current);
                    }
                    
                    audio.onloadedmetadata = () => {
                        const audioDuration = audio.duration * 1000;
                        subtitleTimeoutRef.current = setTimeout(() => {
                            setSubtitleText('');
                        }, audioDuration + 2000);
                    };

                    audio.play();
                    audio.onended = () => setIsPlayingAudio(false);

                } else if (data.conversationTone) {
                    setDetectedTone(data.conversationTone);
                } else if (data.fallbackText) {
                    setNotification({ message: data.fallbackText, type: 'warning' });
                } else if (data.error) {
                    setNotification({ message: data.error, type: 'error' });
                }
            };
            wsRef.current.onclose = () => {
                setStatus('Disconnected. Retrying...');
                setTimeout(connectWebSocket, 3000);
            };
            wsRef.current.onerror = (err) => {
                setStatus('Connection Error: ', err.message);
                wsRef.current.close();
            };
        };
        connectWebSocket();
        return () => {
            if (wsRef.current) wsRef.current.close();
            if (subtitleTimeoutRef.current) clearTimeout(subtitleTimeoutRef.current);
        };
    }, []);

    // --- MediaPipe setup and main logic ---
    useEffect(() => {
        if (!scriptsLoaded) return;
        const videoElement = videoRef.current;
        const canvasElement = canvasRef.current;
        const canvasCtx = canvasElement.getContext('2d');
        const sequenceBuffer = 30;

        const onResults = (results) => {
          setLoading(false);
          canvasCtx.save();
          canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
          canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
          
          if (results.faceLandmarks) {
             window.drawConnectors(canvasCtx, results.faceLandmarks, window.FACEMESH_TESSELATION, {color: 'rgba(255,255,255,0.2)', lineWidth: 1});
          }
          window.drawConnectors(canvasCtx, results.poseLandmarks, window.POSE_CONNECTIONS, {color: 'rgba(255,255,255,0.7)', lineWidth: 2});
          window.drawLandmarks(canvasCtx, results.poseLandmarks, { color: 'rgba(255,255,255,0.9)', radius: 2 });
          window.drawConnectors(canvasCtx, results.leftHandLandmarks, window.HAND_CONNECTIONS, {color: 'rgba(0,191,255,0.8)', lineWidth: 3});
          window.drawLandmarks(canvasCtx, results.leftHandLandmarks, {color: 'rgba(0,191,255,1)', radius: 4});
          window.drawConnectors(canvasCtx, results.rightHandLandmarks, window.HAND_CONNECTIONS, {color: 'rgba(255,165,0,0.8)', lineWidth: 3});
          window.drawLandmarks(canvasCtx, results.rightHandLandmarks, { color: 'rgba(255,165,0,1)', radius: 4 });
          
          canvasCtx.restore();

        //   const pose = results.poseLandmarks || [];
          const leftHand = results.leftHandLandmarks || [];
          const rightHand = results.rightHandLandmarks || [];
          
          if (recordingStateRef.current.mode === 'auto') {
              const handsVisible = leftHand.length > 0 || rightHand.length > 0;
              if (handsVisible && !recordingStateRef.current.isRecording) {
                  clearTimeout(recordingStateRef.current.stopTimeout);
                  recordingStateRef.current.stopTimeout = null;
                  if (!recordingStateRef.current.startTimeout) {
                      recordingStateRef.current.startTimeout = setTimeout(() => {
                          recordingStateRef.current.isRecording = true;
                          recordingStateRef.current.startTimeout = null;
                      }, 500);
                  }
              } else if (!handsVisible && recordingStateRef.current.isRecording) {
                  clearTimeout(recordingStateRef.current.startTimeout);
                  recordingStateRef.current.startTimeout = null;
                  if (!recordingStateRef.current.stopTimeout) {
                      recordingStateRef.current.stopTimeout = setTimeout(() => {
                          recordingStateRef.current.isRecording = false;
                          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                              wsRef.current.send(JSON.stringify({ type: 'end_of_sentence' , tone: recordingStateRef.current.tone}));
                          }
                          recordingStateRef.current.stopTimeout = null;
                      }, 1500);
                  }
              }
          }

          if (recordingStateRef.current.isRecording) {
            const landmarks = [
                ...(results.poseLandmarks ? results.poseLandmarks.map(res => [res.x, res.y, res.z, res.visibility]) : []),
                ...(results.leftHandLandmarks ? results.leftHandLandmarks.map(res => [res.x, res.y, res.z]) : []),
                ...(results.rightHandLandmarks ? results.rightHandLandmarks.map(res => [res.x, res.y, res.z]) : []),
                ...(results.faceLandmarks ? results.faceLandmarks.map(res => [res.x, res.y, res.z]) : [])
            ].flat();
            sequenceRef.current.push(landmarks);
          }
          
          if (sequenceRef.current.length === sequenceBuffer) {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ 
                    type: 'signing_data', 
                    sequence: sequenceRef.current,
                }));
            }
            sequenceRef.current = [];
          }
        };

        const holistic = new window.Holistic({
          locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic/${file}`,
        });
        holistic.setOptions({ modelComplexity: 1, smoothLandmarks: true, enableSegmentation: false, refineFaceLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
        holistic.onResults(onResults);

        const camera = new window.Camera(videoElement, {
          onFrame: async () => await holistic.send({ image: videoElement }),
          width: 1280, height: 720,
        });
        camera.start();
    }, [scriptsLoaded]);

    const handleModeToggle = () => {
        const newMode = uiMode === 'auto' ? 'manual' : 'auto';
        recordingStateRef.current.mode = newMode;
        setUiMode(newMode);
        recordingStateRef.current.isRecording = false;
    };
    
    const handleManualStart = () => {
        if (recordingStateRef.current.mode === 'manual') {
            recordingStateRef.current.isRecording = true;
        }
    };
    
    const handleManualStop = () => {
        if (recordingStateRef.current.mode === 'manual') {
            recordingStateRef.current.isRecording = false;
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ 
                    type: 'end_of_sentence',
                    tone: recordingStateRef.current.tone 
                }));
            }
        }
    };
    
    const getStatusColor = (s) => {
        if (s === 'Connected') return 'text-green-400';
        if (s.includes('Connecting')) return 'text-yellow-400';
        return 'text-red-400';
    };

    return (
        <div className="relative min-h-screen bg-black text-white font-sans overflow-hidden">
            <style>{`
                @keyframes soundwave { 0%, 100% { height: 0.5rem; } 50% { height: 1.5rem; } }
                .animate-soundwave span { animation-name: soundwave; }
            `}</style>

            {notification && (
                <Toast 
                    message={notification.message} 
                    type={notification.type} 
                    onDismiss={() => setNotification(null)} 
                />
            )}

            <div className="absolute inset-0 z-0">
                <video ref={videoRef} className="absolute w-full h-full object-cover" style={{ transform: 'scaleX(-1)', visibility: 'hidden' }} autoPlay playsInline muted></video>
                <canvas ref={canvasRef} className="w-full h-full object-cover" style={{ transform: 'scaleX(-1)' }}></canvas>
                 {loading && (
                    <div className="absolute inset-0 bg-black bg-opacity-70 flex flex-col items-center justify-center z-20">
                        <div className="w-16 h-16 border-4 border-cyan-400 border-t-transparent rounded-full animate-spin"></div>
                        <p className="mt-4 text-xl tracking-wider">Initializing AI & Camera...</p>
                    </div>
                )}
            </div>

            <div className={`absolute bottom-[28vh] left-1/2 -translate-x-1/2 z-20 w-full max-w-4xl px-4 transition-opacity duration-500 ${subtitleText ? 'opacity-100' : 'opacity-0'}`}>
                <div className="bg-black/40 backdrop-blur-md border border-white/20 rounded-2xl shadow-lg p-4">
                    <p className="text-center text-3xl font-semibold text-white tracking-wide">
                        {subtitleText}
                    </p>
                </div>
            </div>

            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10 flex items-end flex-row gap-6">
                <div className="bg-black/30 backdrop-blur-lg border border-white/20 rounded-2xl shadow-lg p-5 w-64">
                    <h2 className="text-xl font-semibold mb-3 text-gray-200">Set Tone</h2>
                    <select 
                        value={conversationTone} 
                        onChange={(e) => {
                            const newTone = e.target.value;
                            setConversationTone(newTone);
                            recordingStateRef.current.tone = newTone;
                        }}
                        className="w-full bg-gray-700/50 border border-white/20 rounded-lg p-2 text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-cyan-400"
                    >
                        <option>Casual</option>
                        <option>Formal</option>
                        <option>Sarcastic</option>
                        <option>Crap Talk</option>
                    </select>
                </div>

                <div className="bg-black/30 backdrop-blur-lg border border-white/20 rounded-2xl shadow-lg p-5 w-52">
                    <h2 className="text-xl font-semibold mb-2 text-gray-200">Status</h2>
                    <div className="flex items-center gap-3">
                        <span className={`font-bold text-lg ${getStatusColor(status)}`}>{status}</span>
                    </div>
                </div>

                <div className="bg-black/30 backdrop-blur-lg border border-white/20 rounded-2xl shadow-lg p-5 w-52">
                    <div className="flex items-center justify-between mb-2">
                        <h2 className="text-xl font-semibold text-gray-200">Detected</h2>
                        {isPlayingAudio && <SoundWaveIcon />}
                    </div>
                    <p className="text-3xl font-bold text-cyan-400 text-center py-2">{detectedTone}</p>
                </div>

                <div className="bg-black/30 backdrop-blur-lg border border-white/20 rounded-2xl shadow-lg p-5 w-80">
                    <h2 className="text-xl font-semibold mb-3 text-gray-200">Controls</h2>
                    <div className="flex items-center justify-between mb-4">
                        <span className="text-lg font-medium text-gray-300">Detection</span>
                        <button onClick={handleModeToggle} className="text-lg font-semibold bg-cyan-600/50 px-4 py-1 rounded-lg hover:bg-cyan-600 transition-all duration-200 transform hover:scale-105">
                            {uiMode === 'auto' ? 'Auto' : 'Manual'}
                        </button>
                    </div>
                    {uiMode === 'manual' && (
                        <div className="flex gap-4">
                            <button onClick={handleManualStart} className="flex-1 bg-green-600/80 text-white font-bold py-3 rounded-lg hover:bg-green-700 transition-all duration-200 transform hover:scale-105 flex items-center justify-center gap-2">
                                <PlayIcon /> Start
                            </button>
                            <button onClick={handleManualStop} className="flex-1 bg-red-600/80 text-white font-bold py-3 rounded-lg hover:bg-red-600 transition-all duration-200 transform hover:scale-105 flex items-center justify-center gap-2">
                                <StopIcon /> Stop
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default App;

