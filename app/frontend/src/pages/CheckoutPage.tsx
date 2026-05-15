import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import toast, { Toaster } from "react-hot-toast";
import { useSessionStore, type WsMessage } from "../stores/sessionStore";
import { useUIStore } from "../stores/uiStore";
import {
  wsCheckoutUrl,
  uploadVideo,
  videoStatusUrl,
  setROI,
  getHealth,
  getBilling,
  updateBilling,
  cancelOcrPending,
} from "../api/checkout";
import BillingPanel from "../components/BillingPanel";
import StatusMetrics from "../components/StatusMetrics";

type Mode = "camera" | "upload";
const captureIntervalRaw = Number(import.meta.env.VITE_CAPTURE_INTERVAL_MS || 80);
const CAPTURE_INTERVAL_MS = Number.isFinite(captureIntervalRaw)
  ? Math.max(33, captureIntervalRaw)
  : 80;
const FULLSCREEN_ROI = [
  [0.0, 0.0], // Top-left
  [1.0, 0.0], // Top-right
  [1.0, 1.0], // Bottom-right
  [0.0, 1.0], // Bottom-left
];

function isSessionNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("404") || msg.includes("session not found");
}

const GUIDE_STEPS = [
  {
    icon: "📦",
    title: "카트를 영역에 맞춰주세요",
    desc: "카메라 앞에 카트나 바구니를 두고\n주황색 박스 안에 카트 입구가 들어오도록\n위치를 조정해주세요.",
  },
  {
    icon: "🛍️",
    title: "아래로 내리면 담기, 위로 올리면 빼기",
    desc: "상품을 위에서 아래로 통과시키면 🟢 장바구니에 담깁니다.\n반대로 아래에서 위로 올리면 🔴 장바구니에서 제거됩니다.",
  },
  {
    icon: "🔄",
    title: "잘못 담았다면 반대로 통과시키세요",
    desc: "실수로 담은 경우 상품을 아래쪽 방향으로\n다시 통과시키면 자동으로 제거됩니다.",
  },
];

type SheetState = "peek" | "half" | "full";
const PEEK_H = 92;
const HALF_H = 360;
const FULL_H = 620;
const SHEET_HEIGHT: Record<SheetState, number> = {
  peek: PEEK_H,
  half: HALF_H,
  full: FULL_H,
};

export default function CheckoutPage() {
  const navigate = useNavigate();
  const toggleChatbot = useUIStore((s) => s.toggleChatbot);
  const setCheckoutSheetH = useUIStore((s) => s.setCheckoutSheetH);

  const [mode] = useState<Mode>("camera");
  const [connected, setConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [modelReady, setModelReady] = useState(false);
  const [sheetState, setSheetState] = useState<SheetState>("half");
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ startY: 0, startH: HALF_H, dragging: false, moved: false });
  const sheetH = SHEET_HEIGHT[sheetState];

  useEffect(() => {
    setCheckoutSheetH(sheetH);
  }, [sheetH, setCheckoutSheetH]);
  const [modelLoadMsg, setModelLoadMsg] = useState("AI 모델 로딩 중...");
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideStep, setGuideStep] = useState(0);
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [cameraSettingsOpen, setCameraSettingsOpen] = useState(false);
  const [zoomSupported, setZoomSupported] = useState(false);
  const [zoomValue, setZoomValue] = useState(1);
  const [zoomMin, setZoomMin] = useState(1);
  const [zoomMax, setZoomMax] = useState(1);
  const [zoomStep, setZoomStep] = useState(0.1);
  const [cameraHint, setCameraHint] = useState("");

  const {
    sessionId,
    createSession,
    updateFromWsMessage,
    setBilling,
    setBillingState,
    billingItems,
    itemScores,
    itemUnitPrices,
    itemLineTotals,
    totalCount,
    totalAmount,
    currency,
    unpricedItems,
    lastLabel,
    lastScore,
    lastStatus,
    countEvent,
    currentTrackId,
    ocrPending,
  } = useSessionStore();

  const wsRef = useRef<WebSocket | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null); // For capturing frames to send to backend
  const displayCanvasRef = useRef<HTMLCanvasElement>(null); // For rendering at 60 FPS
  const streamRef = useRef<MediaStream | null>(null);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const captureAnimRef = useRef<number>(0); // For capture/send loop
  const renderAnimRef = useRef<number>(0); // For render loop (60 FPS)
  const countFlashRef = useRef<number>(0); // count 이벤트 시 화면 플래시
  const lastCountEventKeyRef = useRef<string | null>(null); // 중복 toast 방지

  // Refs mirroring store values for use inside renderFrame closure.
  // renderFrame is created once and runs continuously, so it captures stale
  // closure values if we read store state directly. Refs are always current.
  const lastLabelRef = useRef<string>(lastLabel);
  const lastScoreRef = useRef<number>(lastScore);
  const lastStatusRef = useRef<string>(lastStatus);
  const currentTrackIdRef = useRef<string | null>(currentTrackId);

  // Keep refs in sync with store so renderFrame closure always reads latest values
  useEffect(() => {
    lastLabelRef.current = lastLabel;
    lastScoreRef.current = lastScore;
    lastStatusRef.current = lastStatus;
    currentTrackIdRef.current = currentTrackId;
  }, [lastLabel, lastScore, lastStatus, currentTrackId]);

  const selectPreferredCamera = useCallback((devices: MediaDeviceInfo[]) => {
    if (devices.length === 0) return null;

    const rearKeywords = /(back|rear|environment|후면|광각|ultra|wide)/i;
    const rear = devices.find((d) => rearKeywords.test(d.label));
    return rear?.deviceId ?? devices[0].deviceId;
  }, []);

  const refreshCameraDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;

    const devices = await navigator.mediaDevices.enumerateDevices();
    const videos = devices.filter((d) => d.kind === "videoinput");
    setCameraDevices(videos);
    setSelectedCameraId((prev) => {
      if (prev && videos.some((d) => d.deviceId === prev)) {
        return prev;
      }
      return selectPreferredCamera(videos);
    });
  }, [selectPreferredCamera]);

  const initZoomCapabilities = useCallback(async (track: MediaStreamTrack) => {
    videoTrackRef.current = track;

    const capabilities = ((track.getCapabilities?.() as {
      zoom?: { min: number; max: number; step?: number };
    } | undefined) ?? {});
    const settings = (track.getSettings?.() as { zoom?: number } | undefined) ?? {};
    const zoomCap = capabilities.zoom;

    if (!zoomCap || typeof zoomCap.min !== "number" || typeof zoomCap.max !== "number") {
      setZoomSupported(false);
      setCameraHint("현재 기기/브라우저는 웹 줌 제어를 지원하지 않습니다.");
      return;
    }

    const min = Number(zoomCap.min);
    const max = Number(zoomCap.max);
    const step = Math.max(0.01, Number(zoomCap.step ?? 0.1));
    const current = typeof settings.zoom === "number"
      ? settings.zoom
      : min;

    setZoomSupported(true);
    setZoomMin(min);
    setZoomMax(max);
    setZoomStep(step);
    setZoomValue(current);
    setCameraHint(max > min ? "줌 슬라이더로 화각을 조절할 수 있습니다." : "현재 렌즈는 고정 화각입니다.");

    if (max > min) {
      try {
        await track.applyConstraints({
          advanced: [{ zoom: current } as unknown as MediaTrackConstraintSet],
        });
      } catch (error) {
        console.warn("Failed to apply initial zoom:", error);
      }
    }
  }, []);

  const applyZoom = useCallback(async (nextZoom: number) => {
    setZoomValue(nextZoom);
    const track = videoTrackRef.current;
    if (!track || !zoomSupported) return;

    try {
      await track.applyConstraints({
        advanced: [{ zoom: nextZoom } as unknown as MediaTrackConstraintSet],
      });
    } catch (error) {
      console.warn("Failed to apply zoom:", error);
    }
  }, [zoomSupported]);

  const ensureSessionAndROI = useCallback(async (): Promise<string> => {
    let activeSessionId = sessionId;
    if (!activeSessionId) {
      activeSessionId = await createSession();
    }

    try {
      await setROI(activeSessionId, FULLSCREEN_ROI);
      return activeSessionId;
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        console.warn("Session not found. Recreating session...");
        activeSessionId = await createSession();
        await setROI(activeSessionId, FULLSCREEN_ROI);
        return activeSessionId;
      }
      throw error;
    }
  }, [sessionId, createSession]);

  // Poll backend health until models are loaded
  useEffect(() => {
    if (modelReady) return;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled) {
        try {
          const health = await getHealth();
          if (health.index_vectors && Number(health.index_vectors) > 0) {
            setModelReady(true);
            setModelLoadMsg("");
            return;
          }
          setModelLoadMsg("AI 모델 로딩 중...");
        } catch {
          setModelLoadMsg("서버 연결 대기 중...");
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [modelReady]);

  useEffect(() => {
    refreshCameraDevices().catch((error) => {
      console.warn("Failed to enumerate cameras:", error);
    });

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;

    const onDeviceChange = () => {
      refreshCameraDevices().catch((error) => {
        console.warn("Failed to refresh cameras after device change:", error);
      });
    };

    mediaDevices.addEventListener("devicechange", onDeviceChange);
    return () => {
      mediaDevices.removeEventListener("devicechange", onDeviceChange);
    };
  }, [refreshCameraDevices]);

  // Ensure session exists and setup virtual ROI for entry-event mode.
  // Gated on modelReady to avoid ECONNREFUSED on startup (frontend starts
  // before backend is ready, and a failed createSession leaves sessionId=null).
  useEffect(() => {
    if (!modelReady) return;
    ensureSessionAndROI().catch((err) => {
      console.warn("Failed to ensure session/ROI:", err);
    });
  }, [modelReady, ensureSessionAndROI]);

  // Show toast + flash when count event fires from backend
  useEffect(() => {
    if (!countEvent) {
      lastCountEventKeyRef.current = null;
      return;
    }

    // Deduplicate: backend may send the same event across multiple frames
    const eventKey = `${countEvent.action}|${countEvent.product}|${countEvent.quantity}|${countEvent.track_id}`;
    if (eventKey === lastCountEventKeyRef.current) return;
    lastCountEventKeyRef.current = eventKey;

    const isRemove = countEvent.action === "remove";

    // Trigger canvas border flash (green=add, red=remove)
    countFlashRef.current = isRemove ? -20 : 20; // 음수 = 제거 플래시

    const qtyText = isRemove
      ? countEvent.quantity === 0
        ? '완전히 제거됨'
        : `제거됨 (${countEvent.quantity}개 남음)`
      : `${countEvent.quantity}개 담김`;

    if (isRemove) {
      toast(`🔴 ${countEvent.product} ${qtyText}`, {
        duration: 1000,
        position: "top-center",
        style: {
          background: "#ef4444",
          color: "#fff",
          fontWeight: "600",
          fontSize: "16px",
        },
      });
    } else {
      toast.success(`🟢 ${countEvent.product} ${qtyText}`, {
        icon: "🛒",
        duration: 1000,
        position: "top-center",
        style: {
          background: "#22c55e",
          color: "#fff",
          fontWeight: "600",
          fontSize: "16px",
        },
      });
    }
  }, [countEvent]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      wsRef.current?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      videoTrackRef.current = null;
      cancelAnimationFrame(captureAnimRef.current);
      cancelAnimationFrame(renderAnimRef.current);
    };
  }, []);

  const billingSignature = useMemo(
    () =>
      JSON.stringify(
        Object.entries(billingItems).sort(([a], [b]) => a.localeCompare(b)),
      ),
    [billingItems],
  );

  const hasMultipleCameras = cameraDevices.length > 1;
  const canShowZoomSlider = zoomSupported && zoomMax - zoomMin > 0.001;

  // Fetch latest pricing only when cart composition changes.
  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;
    const fetchBillingState = async () => {
      try {
        const state = await getBilling(sessionId);
        if (!cancelled) {
          setBillingState(state);
        }
      } catch (error) {
        console.warn("Failed to refresh billing prices:", error);
      }
    };

    fetchBillingState();
    return () => {
      cancelled = true;
    };
  }, [sessionId, billingSignature, setBillingState]);

  // --- Camera mode ---
  const stopCamera = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    videoTrackRef.current = null;
    cancelAnimationFrame(captureAnimRef.current);
    cancelAnimationFrame(renderAnimRef.current);
    setConnected(false);
    setIsLoading(false);
    setLoadingMessage("");
    setGuideOpen(false);
    setGuideStep(0);
    setCameraSettingsOpen(false);
    setZoomSupported(false);
  }, []);

  const startCamera = useCallback(async (forcedDeviceId?: string) => {
    try {
      // Start loading state
      setIsLoading(true);
      setLoadingMessage("세션 준비 중...");

      // Ensure session exists on backend before opening WebSocket
      const activeSessionId = await ensureSessionAndROI();

      setLoadingMessage("카메라 권한 요청 중...");

      // Request camera and WebSocket in parallel for better UX
      console.log("📷 Requesting camera access...");

      // Start both operations in parallel
      const activeCameraId = forcedDeviceId ?? selectedCameraId;
      const preferredConstraints: MediaTrackConstraints = activeCameraId
        ? {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            aspectRatio: { ideal: 16 / 9 },
            frameRate: { ideal: 30, max: 60 },
            deviceId: { exact: activeCameraId },
          }
        : {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            aspectRatio: { ideal: 16 / 9 },
            frameRate: { ideal: 30, max: 60 },
            facingMode: { ideal: "environment" },
          };

      const fallbackConstraints: MediaTrackConstraints = {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        aspectRatio: { ideal: 16 / 9 },
        frameRate: { ideal: 30, max: 60 },
        facingMode: { ideal: "environment" },
      };

      const cameraPromise = navigator.mediaDevices.getUserMedia({
        video: preferredConstraints,
      }).catch(async (error) => {
        if (!activeCameraId) {
          throw error;
        }
        console.warn("Selected camera unavailable, fallback to environment lens:", error);
        return navigator.mediaDevices.getUserMedia({ video: fallbackConstraints });
      });

      const ws = new WebSocket(wsCheckoutUrl(activeSessionId));
      wsRef.current = ws;

      const wsPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("WebSocket connection timeout"));
        }, 10000);

        const cleanup = () => {
          clearTimeout(timeout);
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("error", onError);
          ws.removeEventListener("close", onCloseBeforeOpen);
        };

        const onOpen = () => {
          cleanup();
          console.log("✅ WebSocket connected");
          resolve();
        };

        const onError = (err: Event) => {
          cleanup();
          console.error("❌ WebSocket error:", err);
          reject(new Error("WebSocket connection failed"));
        };

        const onCloseBeforeOpen = (event: CloseEvent) => {
          cleanup();
          reject(
            new Error(
              `WebSocket closed before connected (code=${event.code})`,
            ),
          );
        };

        ws.addEventListener("open", onOpen);
        ws.addEventListener("error", onError);
        ws.addEventListener("close", onCloseBeforeOpen);
      });

      // Setup WebSocket message handlers
      ws.onclose = () => {
        console.log("❌ WebSocket closed");
        setConnected(false);
      };
      ws.onmessage = (e) => {
        const data: WsMessage = JSON.parse(e.data);
        console.log("📥 Received state from backend", {
          has_frame: !!data.frame,
          has_roi: !!data.roi_polygon,
          total_count: data.total_count,
          last_label: data.last_label,
        });
        updateFromWsMessage(data);
      };

      // Wait for both camera and WebSocket to be ready
      setLoadingMessage("카메라 및 서버 연결 중...");
      const [stream] = await Promise.all([cameraPromise, wsPromise]);

      console.log("✅ Camera access granted");
      streamRef.current = stream;
      const videoTrack = stream.getVideoTracks()[0] ?? null;
      if (videoTrack) {
        await initZoomCapabilities(videoTrack);
      } else {
        setZoomSupported(false);
        setCameraHint("카메라 트랙을 찾지 못했습니다.");
      }
      await refreshCameraDevices();

      const video = videoRef.current!;
      video.srcObject = stream;

      // Wait for video to be ready
      setLoadingMessage("카메라 준비 중...");
      await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => {
          console.log("📹 Video metadata loaded");
          resolve();
        };
      });

      await video.play();
      console.log("▶️ Video playing");

      // Wait for both video dimensions AND canvas refs to be ready
      // Critical for mobile browsers where DOM mounting can be slower
      setLoadingMessage("화면 초기화 중...");
      await new Promise<void>((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 100; // ~1.6 seconds max wait

        const checkReady = () => {
          attempts++;

          // Check if canvas refs are available
          if (!captureCanvasRef.current || !displayCanvasRef.current) {
            console.log(`⏳ Waiting for canvas refs... (attempt ${attempts})`);
            if (attempts < maxAttempts) {
              requestAnimationFrame(checkReady);
            } else {
              reject(new Error("Canvas refs not available after timeout"));
            }
            return;
          }

          // Check if video dimensions are available
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            console.log(`✅ Ready: video=${video.videoWidth}x${video.videoHeight}, canvases=mounted`);
            resolve();
          } else {
            console.log(`⏳ Waiting for video dimensions... (attempt ${attempts})`);
            if (attempts < maxAttempts) {
              requestAnimationFrame(checkReady);
            } else {
              reject(new Error("Video dimensions not available after timeout"));
            }
          }
        };

        checkReady();
      });

      // Setup canvases - now guaranteed to exist
      const captureCanvas = captureCanvasRef.current;
      const displayCanvas = displayCanvasRef.current;

      if (!captureCanvas || !displayCanvas) {
        throw new Error("Canvas elements not found after ready check");
      }

      // Use actual video dimensions (guaranteed to be > 0 now)
      const canvasWidth = video.videoWidth;
      const canvasHeight = video.videoHeight;

      console.log(`🎨 Setting canvas size: ${canvasWidth}x${canvasHeight}`);

      captureCanvas.width = canvasWidth;
      captureCanvas.height = canvasHeight;
      displayCanvas.width = canvasWidth;
      displayCanvas.height = canvasHeight;

      const captureCtx = captureCanvas.getContext("2d");
      const displayCtx = displayCanvas.getContext("2d");

      if (!captureCtx || !displayCtx) {
        throw new Error("Failed to get 2D context from canvas");
      }

      // 60 FPS rendering loop (local camera + overlay)
      const renderFrame = () => {
        renderAnimRef.current = requestAnimationFrame(renderFrame);

        // Draw video to display canvas
        displayCtx.drawImage(video, 0, 0, displayCanvas.width, displayCanvas.height);

        // ROI = 전체 화면이므로 테두리/오버레이 대신
        // 상단/하단에 방향 가이드 텍스트만 표시
        const W = displayCanvas.width, H = displayCanvas.height;
        const midX = W / 2;
        displayCtx.textAlign = 'center';
        displayCtx.font = 'bold 16px sans-serif';
        displayCtx.lineWidth = 3;

        // 상단 라벨 - 담기 (상단 진입 = 담기)
        displayCtx.strokeStyle = 'rgba(0,0,0,0.7)';
        displayCtx.strokeText('↓ 담기', midX, 28);
        displayCtx.fillStyle = 'rgba(34, 197, 94, 1)';
        displayCtx.fillText('↓ 담기', midX, 28);

        // 하단 라벨 - 빼기 (하단 진입 = 빼기)
        displayCtx.strokeStyle = 'rgba(0,0,0,0.7)';
        displayCtx.strokeText('↑ 빼기', midX, H - 12);
        displayCtx.fillStyle = 'rgba(239, 68, 68, 1)';
        displayCtx.fillText('↑ 빼기', midX, H - 12);

        displayCtx.textAlign = 'left'; // 기본값 복원

        // Count flash effect (green=add, red=remove)
        if (countFlashRef.current !== 0) {
          const isRemoveFlash = countFlashRef.current < 0;
          const remaining = Math.abs(countFlashRef.current);
          const alpha = Math.min(1, remaining / 15);
          displayCtx.strokeStyle = isRemoveFlash
            ? `rgba(239, 68, 68, ${alpha})`   // 빨강 = 제거
            : `rgba(34, 197, 94, ${alpha})`;   // 초록 = 담기
          displayCtx.lineWidth = 6;
          displayCtx.strokeRect(0, 0, displayCanvas.width, displayCanvas.height);
          countFlashRef.current += isRemoveFlash ? 1 : -1; // 0을 향해 수렴
        }

        // Draw status text overlay (read from refs to get latest values)
        const currentLabel = lastLabelRef.current;
        const currentScore = lastScoreRef.current;
        const currentStatus = lastStatusRef.current;
        const currentTrack = currentTrackIdRef.current;
        if (currentLabel && currentLabel !== "-") {
          const trackStr = currentTrack ? ` [ID:${currentTrack}]` : "";
          const text = `${currentLabel} (${currentScore.toFixed(3)})${trackStr}`;
          displayCtx.font = 'bold 18px sans-serif';

          displayCtx.strokeStyle = 'black';
          displayCtx.lineWidth = 4;
          displayCtx.strokeText(text, 10, 30);

          displayCtx.fillStyle = 'white';
          displayCtx.fillText(text, 10, 30);
        }

        // Draw status indicator
        if (currentStatus) {
          const statusText = currentTrack
            ? `${currentStatus} | Track:${currentTrack}`
            : currentStatus;
          const textWidth = displayCtx.measureText(statusText).width + 20;
          displayCtx.font = '14px sans-serif';
          displayCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
          displayCtx.fillRect(10, displayCanvas.height - 30, textWidth, 20);
          displayCtx.fillStyle = 'white';
          displayCtx.fillText(statusText, 15, displayCanvas.height - 15);
        }
      };

      // 10-15 FPS capture and send loop
      let lastSend = 0;
      let frameCount = 0;
      const sendFrame = () => {
        captureAnimRef.current = requestAnimationFrame(sendFrame);
        const now = performance.now();

        // Throttle capture loop (env-configurable)
        if (now - lastSend < CAPTURE_INTERVAL_MS) return;

        if (ws.readyState !== WebSocket.OPEN) {
          if (frameCount === 0) {
            console.log("⏳ Waiting for WebSocket to be ready...");
          }
          return;
        }

        captureCtx.drawImage(video, 0, 0);
        captureCanvas.toBlob(
          (blob) => {
            if (blob && ws.readyState === WebSocket.OPEN) {
              ws.send(blob);
              frameCount++;
              if (frameCount === 1) {
                console.log("📤 First frame sent to backend");
              }
              lastSend = performance.now();
            }
          },
          "image/jpeg",
          0.7,
        );
      };

      console.log("🎬 Starting 60 FPS render loop and 12.5 FPS capture loop");
      renderFrame();
      sendFrame();

      // All ready - show camera feed + guide modal
      setLoadingMessage("완료!");
      setTimeout(() => {
        setConnected(true);
        setIsLoading(false);
        setLoadingMessage("");
        setGuideOpen(true);
        setGuideStep(0);
      }, 300);
    } catch (error) {
      console.error("❌ Camera error:", error);
      setIsLoading(false);
      setLoadingMessage("");
      alert(`Failed to start camera: ${error instanceof Error ? error.message : String(error)}`);
      stopCamera();
    }
  // Store values (roiPolygon, lastLabel, etc.) removed from deps — they're
  // accessed via refs inside renderFrame, so startCamera doesn't need to
  // rebuild the render loop every time the store updates.
  }, [
    ensureSessionAndROI,
    initZoomCapabilities,
    refreshCameraDevices,
    selectedCameraId,
    stopCamera,
    updateFromWsMessage,
  ]);

  const handleCameraDeviceChange = useCallback(async (deviceId: string) => {
    setSelectedCameraId(deviceId);
    if (!connected) return;

    stopCamera();
    await new Promise((resolve) => setTimeout(resolve, 120));
    void startCamera(deviceId);
  }, [connected, startCamera, stopCamera]);

  const handleCancelOcrPending = useCallback(async () => {
    if (!sessionId) return;
    try {
      await cancelOcrPending(sessionId);
    } catch (error) {
      console.warn("Failed to cancel OCR pending:", error);
    }
  }, [sessionId]);

  // --- Upload mode ---
  const handleUpload = useCallback(
    async (file: File) => {
      if (!sessionId) return;
      setUploadProgress(0);

      const { task_id } = await uploadVideo(sessionId, file);

      // Listen SSE
      const evtSource = new EventSource(videoStatusUrl(sessionId, task_id));
      evtSource.onmessage = (e) => {
        const data = JSON.parse(e.data);
        setUploadProgress(Math.round(data.progress * 100));
        setBilling(data.billing_items);

        if (data.done) {
          evtSource.close();
          setUploadProgress(null);
        }
        if (data.error) {
          evtSource.close();
          setUploadProgress(null);
          alert(`Video error: ${data.error}`);
        }
      };
      evtSource.onerror = () => {
        evtSource.close();
        setUploadProgress(null);
      };
    },
    [sessionId, setBilling],
  );

  // --- Bottom sheet drag handlers (mobile) ---
  const onSheetDragStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      const y =
        "touches" in e
          ? e.touches[0].clientY
          : (e as React.MouseEvent).clientY;
      dragRef.current = {
        startY: y,
        startH: sheetH,
        dragging: true,
        moved: false,
      };
    },
    [sheetH],
  );

  const onSheetDragMove = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      const drag = dragRef.current;
      if (!drag.dragging) return;
      const y =
        "touches" in e
          ? e.touches[0].clientY
          : (e as React.MouseEvent).clientY;
      const dy = drag.startY - y;
      if (Math.abs(dy) > 4) drag.moved = true;
      const newH = Math.max(PEEK_H - 20, Math.min(FULL_H + 20, drag.startH + dy));
      if (sheetRef.current) sheetRef.current.style.height = `${newH}px`;
    },
    [],
  );

  const onSheetDragEnd = useCallback(() => {
    const drag = dragRef.current;
    if (!drag.dragging) return;
    drag.dragging = false;
    if (!drag.moved) {
      // Pure click — let onClick cycle states; clear inline height
      if (sheetRef.current) sheetRef.current.style.height = "";
      return;
    }
    const h = sheetRef.current
      ? parseFloat(sheetRef.current.style.height)
      : sheetH;
    let next: SheetState;
    if (!Number.isFinite(h)) next = sheetState;
    else if (h < (PEEK_H + HALF_H) / 2) next = "peek";
    else if (h < (HALF_H + FULL_H) / 2) next = "half";
    else next = "full";
    setSheetState(next);
    if (sheetRef.current) sheetRef.current.style.height = "";
  }, [sheetH, sheetState]);

  const cycleSheet = () => {
    setSheetState((s) => (s === "peek" ? "half" : s === "half" ? "full" : "peek"));
  };

  const decrementBillingItem = useCallback(
    async (productName: string) => {
      if (!sessionId) return;
      const next: Record<string, number> = { ...billingItems };
      const nextQty = Math.max(0, (next[productName] ?? 0) - 1);
      if (nextQty === 0) {
        delete next[productName];
      } else {
        next[productName] = nextQty;
      }
      try {
        const state = await updateBilling(sessionId, next);
        setBillingState(state);
      } catch (err) {
        console.error("[billing] decrement failed", err);
        toast.error("수량 변경에 실패했어요");
      }
    },
    [sessionId, billingItems, setBillingState],
  );

  // Full-screen loading overlay while models load
  if (!modelReady) {
    return (
      <div className="h-full flex items-center justify-center bg-[var(--color-bg)]">
        <div className="text-center space-y-6 p-8">
          {/* Animated loading indicator */}
          <div className="relative w-20 h-20 mx-auto">
            <div className="absolute inset-0 border-4 border-[var(--color-surface-light)] rounded-full" />
            <div className="absolute inset-0 border-4 border-transparent border-t-[var(--color-primary)] rounded-full animate-spin" />
          </div>

          <div className="space-y-2">
            <h2 className="text-xl font-bold text-[var(--color-text)]">
              시스템 준비 중
            </h2>
            <p className="text-sm text-[var(--color-text-muted)]">
              {modelLoadMsg}
            </p>
          </div>

          {/* Progress dots animation */}
          <div className="flex justify-center gap-1.5">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="w-2 h-2 rounded-full bg-[var(--color-primary)] animate-pulse"
                style={{ animationDelay: `${i * 0.3}s` }}
              />
            ))}
          </div>

          <p className="text-xs text-[var(--color-text-muted)]">
            DINOv2 + CLIP 모델과 FAISS 인덱스를 불러오고 있습니다
          </p>
        </div>
      </div>
    );
  }

  const sortedBillingEntries = Object.entries(billingItems).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  const cameraSettingsPanel = (
    <div className="absolute top-14 right-3 md:top-16 md:right-4 z-20 w-72 bg-white/95 backdrop-blur rounded-xl border border-gray-200 shadow-xl p-3 space-y-3">
      <div>
        <p className="text-xs font-semibold text-gray-700 mb-1">렌즈 선택</p>
        <select
          value={selectedCameraId ?? ""}
          onChange={(e) => {
            const next = e.target.value;
            if (next) {
              void handleCameraDeviceChange(next);
            }
          }}
          className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
          disabled={!hasMultipleCameras}
        >
          {cameraDevices.length === 0 && <option value="">카메라를 찾는 중...</option>}
          {cameraDevices.map((device, idx) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || `카메라 ${idx + 1}`}
            </option>
          ))}
        </select>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold text-gray-700">디지털 줌</p>
          <p className="text-xs text-gray-500">{zoomValue.toFixed(2)}x</p>
        </div>
        <input
          type="range"
          min={zoomMin}
          max={zoomMax}
          step={zoomStep}
          value={zoomValue}
          disabled={!canShowZoomSlider}
          onChange={(e) => void applyZoom(Number(e.target.value))}
          className="w-full accent-[var(--color-primary)] disabled:opacity-40"
        />
        <p className="text-[11px] text-gray-500 mt-1">
          {cameraHint || "렌즈마다 지원 가능한 줌 범위가 다릅니다."}
        </p>
      </div>
    </div>
  );

  const ocrPendingModal = ocrPending && (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50">
      <div className="relative bg-white rounded-2xl p-6 mx-4 w-full max-w-sm shadow-2xl text-center space-y-4">
        <button
          onClick={() => void handleCancelOcrPending()}
          className="absolute top-3 right-3 w-8 h-8 rounded-full border border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          aria-label="OCR 인식 취소"
          title="OCR 인식 취소"
        >
          ×
        </button>
        <div className="text-4xl">🔍</div>
        <h3 className="font-bold text-gray-900 text-base">상품 인식이 잘 안됐어요</h3>
        <p className="text-sm text-gray-500 leading-relaxed">
          카메라 화면에 상품 앞면을
          <br />
          가까이 비춰주세요
        </p>
        <div className="flex items-center justify-center gap-2 text-[var(--color-primary)] text-sm font-medium">
          <span className="w-2 h-2 rounded-full bg-[var(--color-primary)] animate-ping" />
          OCR 인식 중...
        </div>
      </div>
    </div>
  );

  const guideModal = guideOpen && (
    <div className="absolute inset-0 z-20 flex items-end justify-center pb-8">
      <div className="bg-white rounded-2xl p-5 mx-4 w-full max-w-sm shadow-2xl">
        <div className="text-center space-y-3">
          <div className="text-3xl">{GUIDE_STEPS[guideStep].icon}</div>
          <h3 className="font-bold text-gray-900 text-sm md:text-base">
            {GUIDE_STEPS[guideStep].title}
          </h3>
          <p className="text-xs md:text-sm text-gray-500 whitespace-pre-line leading-relaxed">
            {GUIDE_STEPS[guideStep].desc}
          </p>
          <div className="flex justify-center gap-2 py-1">
            {GUIDE_STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-2 rounded-full transition-all duration-300 ${
                  i === guideStep
                    ? "w-5 bg-[var(--color-primary)]"
                    : "w-2 bg-gray-200"
                }`}
              />
            ))}
          </div>
          <div className="flex gap-2 pt-1">
            {guideStep > 0 && (
              <button
                onClick={() => setGuideStep((s) => s - 1)}
                className="flex-1 py-2.5 border border-gray-200 text-gray-600 rounded-xl text-sm font-medium"
              >
                이전
              </button>
            )}
            <button
              onClick={() => {
                if (guideStep < GUIDE_STEPS.length - 1) {
                  setGuideStep((s) => s + 1);
                } else {
                  setGuideOpen(false);
                }
              }}
              className="flex-1 py-2.5 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-xl text-sm font-semibold transition-colors"
            >
              {guideStep < GUIDE_STEPS.length - 1 ? "다음" : "시작하기"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  const cameraIdleCta = (
    <div className="text-center">
      <span className="text-5xl md:text-6xl mb-3 md:mb-4 block">
        {isLoading ? "⏳" : "📷"}
      </span>
      <p className="text-gray-400 mb-3 md:mb-4 text-sm md:text-base">
        {isLoading ? loadingMessage : "카메라를 시작하려면 버튼을 클릭하세요"}
      </p>
      {isLoading && (
        <div className="mb-4">
          <div className="inline-block w-8 h-8 border-4 border-gray-600 border-t-[var(--color-success)] rounded-full animate-spin"></div>
        </div>
      )}
      <button
        onClick={() => void startCamera()}
        disabled={isLoading}
        className="px-5 py-2.5 md:px-6 md:py-3 bg-[var(--color-success)] hover:bg-[var(--color-success-hover)] text-white rounded-lg md:rounded-xl text-sm md:text-base font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-lg"
      >
        {isLoading ? "준비 중..." : "카메라 시작"}
      </button>
      {cameraDevices.length > 0 && (
        <div className="mt-4 max-w-xs mx-auto text-left bg-black/30 border border-white/20 rounded-xl p-3 space-y-2">
          <p className="text-xs text-gray-200 font-semibold">렌즈 미리 선택</p>
          <select
            value={selectedCameraId ?? ""}
            onChange={(e) => {
              const next = e.target.value;
              if (next) {
                void handleCameraDeviceChange(next);
              }
            }}
            className="w-full border border-gray-500 bg-black/20 text-gray-100 rounded-lg px-2 py-1.5 text-sm"
          >
            {cameraDevices.map((device, idx) => (
              <option
                key={device.deviceId}
                value={device.deviceId}
                className="text-black"
              >
                {device.label || `카메라 ${idx + 1}`}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );

  const uploadMode =
    uploadProgress !== null ? (
      <div className="text-center space-y-3">
        <div className="w-48 md:w-64 h-2 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-[var(--color-primary)] transition-all"
            style={{ width: `${uploadProgress}%` }}
          />
        </div>
        <span className="text-gray-300 text-xs md:text-sm">
          처리 중: {uploadProgress}%
        </span>
      </div>
    ) : (
      <label className="cursor-pointer text-gray-400 hover:text-gray-200 transition-colors">
        <span className="text-5xl md:text-6xl mb-3 md:mb-4 block">📁</span>
        <span className="text-xs md:text-sm">영상 업로드</span>
        <input
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUpload(f);
          }}
        />
      </label>
    );

  return (
    <>
      <Toaster />

      {/* Single shared layout — responsive via Tailwind.
          Mobile: camera tile = viewport height minus bottom nav (64px).
          Desktop (lg+): camera tile + 420px sidebar side by side. */}
      <div className="h-[calc(100dvh-64px)] lg:h-full relative lg:p-6 lg:flex lg:gap-6">
        {/* Camera tile */}
        <div className="relative h-full w-full bg-[var(--color-camera-bg)] overflow-hidden lg:flex-1 lg:rounded-2xl lg:flex lg:items-center lg:justify-center">
          {/* Shared video + canvases (single DOM instance) */}
          <video ref={videoRef} className="hidden" playsInline muted />
          <canvas ref={captureCanvasRef} className="hidden" />
          <canvas
            ref={displayCanvasRef}
            className={`absolute inset-0 w-full h-full object-cover lg:static lg:inset-auto lg:w-auto lg:h-auto lg:max-w-full lg:max-h-full lg:object-contain ${
              mode === "camera" && connected ? "" : "hidden"
            }`}
          />

          {/* Decorative grid when idle */}
          {!(mode === "camera" && connected) && (
            <div
              className="absolute inset-0 opacity-60 pointer-events-none lg:hidden"
              style={{
                backgroundImage:
                  "linear-gradient(rgba(148,163,184,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.05) 1px, transparent 1px)",
                backgroundSize: "32px 32px",
              }}
            />
          )}

          {mode === "camera" ? (
            connected ? (
              <>
                {/* ---- DESKTOP overlays ---- */}
                <div className="hidden lg:block">
                  <div className="absolute top-4 left-4 bg-[var(--color-success)] text-white px-3 py-1 rounded-full text-sm font-semibold flex items-center gap-2">
                    <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
                    Live
                  </div>
                  <button
                    onClick={() => setCameraSettingsOpen((prev) => !prev)}
                    className="absolute top-4 right-4 px-3 py-1.5 bg-black/50 hover:bg-black/65 text-white rounded-lg text-sm font-semibold transition-colors"
                  >
                    카메라 설정
                  </button>
                  <button
                    onClick={stopCamera}
                    className="absolute bottom-4 right-4 px-6 py-2 bg-[var(--color-danger)] hover:bg-[var(--color-danger-hover)] text-white rounded-xl text-sm font-semibold transition-colors shadow-lg"
                  >
                    정지
                  </button>
                </div>

                {/* ---- MOBILE overlays ---- */}
                <div className="lg:hidden">
                  {/* Top chrome */}
                  <div
                    className="absolute left-0 right-0 z-[4] flex items-center justify-between px-3"
                    style={{ top: "calc(env(safe-area-inset-top, 0px) + 14px)" }}
                  >
                    <button
                      onClick={stopCamera}
                      className="w-10 h-10 rounded-full border-0 bg-slate-900/55 backdrop-blur text-white text-xl"
                      aria-label="나가기"
                    >
                      ←
                    </button>
                    <div className="px-3 py-2 rounded-full bg-slate-900/60 backdrop-blur text-white text-xs font-mono flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] shadow-[0_0_8px_var(--color-success)]" />
                      <span>LIVE</span>
                      {currentTrackId && (
                        <>
                          <span className="text-slate-400">·</span>
                          <span>Track:{currentTrackId}</span>
                        </>
                      )}
                    </div>
                    <button
                      onClick={() => setCameraSettingsOpen((prev) => !prev)}
                      className="w-10 h-10 rounded-full border-0 bg-slate-900/55 backdrop-blur text-white text-base"
                      aria-label="카메라 설정"
                    >
                      ⚙︎
                    </button>
                  </div>

                  {/* Viewfinder corners — center above sheet */}
                  <div
                    className="absolute left-0 right-0 top-0 flex items-center justify-center pointer-events-none z-[2] transition-[bottom] duration-300 ease-[cubic-bezier(.4,0,.2,1)]"
                    style={{ bottom: sheetH }}
                  >
                    <div className="relative w-60 h-60">
                      <div
                        className="absolute top-0 left-0 w-7 h-7 rounded-tl-xl"
                        style={{
                          borderTop: "3px solid var(--color-primary)",
                          borderLeft: "3px solid var(--color-primary)",
                          boxShadow: "0 0 16px rgba(249,115,22,0.4)",
                        }}
                      />
                      <div
                        className="absolute top-0 right-0 w-7 h-7 rounded-tr-xl"
                        style={{
                          borderTop: "3px solid var(--color-primary)",
                          borderRight: "3px solid var(--color-primary)",
                          boxShadow: "0 0 16px rgba(249,115,22,0.4)",
                        }}
                      />
                      <div
                        className="absolute bottom-0 left-0 w-7 h-7 rounded-bl-xl"
                        style={{
                          borderBottom: "3px solid var(--color-primary)",
                          borderLeft: "3px solid var(--color-primary)",
                          boxShadow: "0 0 16px rgba(249,115,22,0.4)",
                        }}
                      />
                      <div
                        className="absolute bottom-0 right-0 w-7 h-7 rounded-br-xl"
                        style={{
                          borderBottom: "3px solid var(--color-primary)",
                          borderRight: "3px solid var(--color-primary)",
                          boxShadow: "0 0 16px rgba(249,115,22,0.4)",
                        }}
                      />
                      <span
                        className="absolute top-2 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-full text-[11px] font-semibold text-white backdrop-blur-sm whitespace-nowrap"
                        style={{ backgroundColor: "rgba(34,197,94,0.85)" }}
                      >
                        ↓ 담기
                      </span>
                      <span
                        className="absolute bottom-2 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-full text-[11px] font-semibold text-white backdrop-blur-sm whitespace-nowrap"
                        style={{ backgroundColor: "rgba(239,68,68,0.85)" }}
                      >
                        ↑ 빼기
                      </span>
                    </div>
                  </div>

                  {/* Status bar above sheet */}
                  <div
                    className="absolute left-3 right-3 z-[3] px-3 py-2 rounded-[10px] bg-slate-900/65 backdrop-blur flex items-center gap-2 text-[11px] font-mono transition-[bottom] duration-300 ease-[cubic-bezier(.4,0,.2,1)]"
                    style={{ bottom: sheetH + 12 }}
                  >
                    <span className="text-[var(--color-success)]">● OCR_READY</span>
                    <span className="text-slate-500">|</span>
                    <span className="text-slate-400 flex-1 truncate">
                      {lastStatus || "상품을 카메라에 보여주세요"}
                    </span>
                  </div>

                  {/* Chatbot FAB — above sheet, never overlaps checkout */}
                  <button
                    onClick={toggleChatbot}
                    className="absolute right-4 z-[25] w-[52px] h-[52px] rounded-full border-2 border-white/15 text-white text-[22px] flex items-center justify-center transition-[bottom] duration-300 ease-[cubic-bezier(.4,0,.2,1)]"
                    style={{
                      bottom: sheetH + 68,
                      background: "linear-gradient(135deg, #fb923c, #f97316)",
                      boxShadow:
                        "0 10px 24px rgba(249,115,22,0.45), 0 0 0 4px rgba(249,115,22,0.12)",
                    }}
                    aria-label="챗봇"
                  >
                    🤖
                  </button>

                  {/* Bottom sheet */}
                  <div
                    ref={sheetRef}
                    className="absolute left-0 right-0 bottom-0 bg-white flex flex-col z-[10]"
                    style={{
                      height: sheetH,
                      borderRadius: "22px 22px 0 0",
                      boxShadow: "0 -12px 40px rgba(0,0,0,0.28)",
                      transition: dragRef.current.dragging
                        ? "none"
                        : "height 300ms cubic-bezier(.4,0,.2,1)",
                    }}
                  >
                    <div
                      onMouseDown={onSheetDragStart}
                      onMouseMove={onSheetDragMove}
                      onMouseUp={onSheetDragEnd}
                      onMouseLeave={onSheetDragEnd}
                      onTouchStart={onSheetDragStart}
                      onTouchMove={onSheetDragMove}
                      onTouchEnd={onSheetDragEnd}
                      onClick={cycleSheet}
                      style={{ touchAction: "none" }}
                      className="pt-2 pb-1 flex flex-col items-center cursor-grab select-none"
                    >
                      <div className="w-10 h-1 bg-slate-300 rounded-full" />
                    </div>

                    <div className="px-5 pb-2.5 flex items-center justify-between">
                      <div>
                        <div className="text-[17px] font-bold text-slate-900 flex items-center gap-2">
                          장바구니
                          {totalCount > 0 && (
                            <span className="text-[11px] font-bold bg-[var(--color-primary)] text-white px-2 py-0.5 rounded-full">
                              {totalCount}
                            </span>
                          )}
                        </div>
                        <div className="text-[11.5px] text-slate-500 mt-0.5">
                          {sortedBillingEntries.length}종 · 총 {totalCount}개
                        </div>
                      </div>
                      <div className="text-[20px] font-extrabold text-slate-900 tracking-tight">
                        ₩{totalAmount.toLocaleString()}
                      </div>
                    </div>

                    {sheetState !== "peek" && (
                      <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-2">
                        {sortedBillingEntries.length === 0 ? (
                          <div className="py-7 text-center text-slate-400 text-sm">
                            🛒 아직 담긴 상품이 없어요
                            <br />
                            <span className="text-xs">
                              카메라 앞에 상품을 보여주세요
                            </span>
                          </div>
                        ) : (
                          sortedBillingEntries.map(([name, qty], idx) => {
                            const unitPrice = itemUnitPrices[name];
                            const lineTotal = itemLineTotals[name];
                            const hasPrice = unitPrice != null;
                            return (
                              <div
                                key={name}
                                className={`flex items-center gap-3 py-2.5 ${
                                  idx < sortedBillingEntries.length - 1
                                    ? "border-b border-slate-100"
                                    : ""
                                }`}
                              >
                                <div className="w-11 h-11 rounded-[10px] bg-[var(--color-primary-light)] flex items-center justify-center text-[var(--color-primary)] font-bold text-sm flex-shrink-0">
                                  {name[0]}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm font-semibold text-slate-900 truncate">
                                    {name}
                                  </div>
                                  <div className="text-[11px] text-slate-500 mt-0.5">
                                    {hasPrice
                                      ? `₩${unitPrice.toLocaleString()} × ${qty}`
                                      : `수량 ${qty} · 가격 정보 없음`}
                                    {itemScores[name] !== undefined && (
                                      <span className="text-slate-400">
                                        {" "}
                                        · {itemScores[name].toFixed(2)}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="text-sm font-bold text-slate-900 min-w-16 text-right">
                                  {hasPrice && lineTotal != null
                                    ? `₩${lineTotal.toLocaleString()}`
                                    : "—"}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => void decrementBillingItem(name)}
                                  aria-label={`${name} 하나 빼기`}
                                  className="w-7 h-7 rounded-full border border-slate-200 text-slate-500 flex items-center justify-center text-base leading-none hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] active:bg-[var(--color-danger)]/10 transition-colors flex-shrink-0"
                                >
                                  −
                                </button>
                              </div>
                            );
                          })
                        )}
                        {unpricedItems.length > 0 && (
                          <div className="mt-2 p-2 rounded-md bg-amber-50 border border-amber-200 text-[11px] text-amber-700">
                            가격 미등록: {unpricedItems.join(", ")}
                          </div>
                        )}
                      </div>
                    )}

                    <div
                      className={`px-4 pb-4 pt-2 bg-white ${
                        sheetState !== "peek" ? "border-t border-slate-100" : ""
                      }`}
                    >
                      <button
                        disabled={totalCount === 0}
                        onClick={() => navigate("/validate")}
                        className="w-full py-3.5 rounded-[14px] text-[15px] font-bold text-white flex items-center justify-center gap-2.5 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed"
                        style={
                          totalCount > 0
                            ? {
                                background:
                                  "linear-gradient(180deg, #fb923c, #f97316)",
                                boxShadow:
                                  "0 6px 20px rgba(249,115,22,0.38)",
                              }
                            : undefined
                        }
                      >
                        <span aria-hidden="true" className="text-[17px] leading-none">🛒</span>
                        <span>결제하기</span>
                        {totalCount > 0 && (
                          <span className="bg-black/15 px-2.5 py-0.5 rounded-full text-[13px]">
                            ₩{totalAmount.toLocaleString()}
                          </span>
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                {/* ---- Shared overlays (both viewports) ---- */}
                {cameraSettingsOpen && cameraSettingsPanel}
                {ocrPendingModal}
                {guideModal}
              </>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center px-6 bg-[var(--color-camera-bg)]">
                {cameraIdleCta}
              </div>
            )
          ) : (
            <div className="absolute inset-0 flex items-center justify-center px-6 bg-[var(--color-camera-bg)]">
              {uploadMode}
            </div>
          )}
        </div>

        {/* Desktop sidebar */}
        <div className="hidden lg:flex w-[420px] flex-col gap-4">
          <StatusMetrics
            lastLabel={lastLabel}
            lastScore={lastScore}
            lastStatus={lastStatus}
            fps={undefined}
            trackId={currentTrackId}
          />
          <div className="flex-1 min-h-0">
            <BillingPanel
              billingItems={billingItems}
              itemScores={itemScores}
              itemUnitPrices={itemUnitPrices}
              itemLineTotals={itemLineTotals}
              totalCount={totalCount}
              totalAmount={totalAmount}
              currency={currency}
              unpricedItems={unpricedItems}
            />
          </div>
        </div>
      </div>
    </>
  );
}
