import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addProduct, deleteProduct, getProductDetail, listProducts, updateProductDetail } from "../api/products";

const MIN_IMAGES = 3;
const RECOMMENDED_MAX_IMAGES = 5;
const STABLE_MAX_IMAGES = 10;

const WIZARD_ANGLES = [
  { key: "front", label: "정면", icon: "▢" },
  { key: "left", label: "좌 45°", icon: "◩" },
  { key: "right", label: "우 45°", icon: "◪" },
  { key: "top", label: "위", icon: "⬒" },
  { key: "bottom", label: "바닥", icon: "⬓" },
] as const;

interface CapturedImage {
  id: string;
  file: File;
  url: string;
  angleLabel?: string;
}

export default function ProductsPage() {
  const queryClient = useQueryClient();
  const [itemNo, setItemNo] = useState("");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [barcd, setBarcd] = useState("");

  const [captured, setCaptured] = useState<CapturedImage[]>([]);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [startingCamera, setStartingCamera] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{
    itemNo: string;
    name: string;
  } | null>(null);
  const [selectedItemNo, setSelectedItemNo] = useState<string | null>(null);
  const [detailForm, setDetailForm] = useState<{
    product_name: string;
    barcd: string;
    price: string;
    stock: string;
    is_discounted: boolean;
    discount_rate: string;
    discount_amount: string;
  } | null>(null);

  // Mobile wizard state (below md: breakpoint)
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [wizardQuery, setWizardQuery] = useState("");
  const [shutterFlash, setShutterFlash] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const capturedRef = useRef<CapturedImage[]>([]);

  const images = useMemo(() => captured.map((c) => c.file), [captured]);
  const priceValue = Number(price);
  const hasValidPrice = Number.isFinite(priceValue) && priceValue > 0;
  const canSubmit =
    itemNo.trim().length > 0 &&
    name.trim().length > 0 &&
    hasValidPrice &&
    images.length >= MIN_IMAGES &&
    images.length <= STABLE_MAX_IMAGES;
  const formatRateInput = (value: number): string =>
    value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  const toDiscountedPrice = (price: number, rate: number): number =>
    Math.max(0, Math.round(price * (1 - rate / 100)));
  const toDiscountRate = (price: number, discountedPrice: number): number =>
    Math.max(0, Math.min(100, (1 - discountedPrice / price) * 100));

  const { data, isLoading } = useQuery({
    queryKey: ["products"],
    queryFn: listProducts,
  });

  const mutation = useMutation({
    mutationFn: () =>
      addProduct({
        itemNo,
        name,
        price: priceValue,
        barcd,
        images,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      setItemNo("");
      setName("");
      setPrice("");
      setBarcd("");
      setCaptured((prev) => {
        prev.forEach((img) => URL.revokeObjectURL(img.url));
        return [];
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (itemNoValue: string) => deleteProduct(itemNoValue),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });

  const { data: detail, isLoading: isDetailLoading, isError: isDetailError } = useQuery({
    queryKey: ["product-detail", selectedItemNo],
    queryFn: () => getProductDetail(selectedItemNo!),
    enabled: !!selectedItemNo,
  });

  const updateDetailMutation = useMutation({
    mutationFn: () => {
      if (!selectedItemNo || !detailForm) {
        throw new Error("수정할 상품이 선택되지 않았습니다.");
      }

      const payload: {
        product_name?: string;
        barcd?: string | null;
        price?: number;
        stock?: number;
        is_discounted?: boolean;
        discount_rate?: number;
        discount_amount?: number;
      } = {};

      const trimmedName = detailForm.product_name.trim();
      if (trimmedName.length > 0) {
        payload.product_name = trimmedName;
      }

      payload.barcd = detailForm.barcd.trim() || null;

      const priceValue = Number(detailForm.price);
      if (Number.isFinite(priceValue) && priceValue > 0) {
        payload.price = Math.trunc(priceValue);
      }

      if (detail?.available_fields.stock) {
        const stockValue = Number(detailForm.stock);
        if (Number.isFinite(stockValue) && stockValue >= 0) {
          payload.stock = Math.trunc(stockValue);
        }
      }

      if (detail?.available_fields.discount) {
        payload.is_discounted = detailForm.is_discounted;
        const rateValue = Number(detailForm.discount_rate);
        if (Number.isFinite(rateValue) && rateValue >= 0) {
          payload.discount_rate = rateValue;
        }
        const amountValue = Number(detailForm.discount_amount);
        if (Number.isFinite(amountValue) && amountValue >= 0) {
          payload.discount_amount = Math.trunc(amountValue);
        }
      }

      return updateProductDetail(selectedItemNo, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["product-detail", selectedItemNo] });
    },
  });

  const loadDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = list.filter((device) => device.kind === "videoinput");
      setDevices(videoInputs);
      if (!selectedDeviceId && videoInputs.length > 0) {
        // Prefer the rear/back camera. iOS labels: "Back Camera", "Back Ultra Wide Camera".
        // Android labels often contain "back" or "facing back". When no label matches
        // (desktop webcams or pre-permission enumeration), fall back to the first device.
        const rearKeywords = /(back|rear|environment|후면|광각|ultra|wide)/i;
        const rear = videoInputs.find((d) => rearKeywords.test(d.label));
        setSelectedDeviceId(rear?.deviceId ?? videoInputs[0].deviceId);
      }
    } catch {
      // ignore
    }
  };

  const stopCamera = (updateState = true) => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (updateState) {
      setCameraActive(false);
    }
  };

  const startCamera = async (deviceId?: string) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("이 브라우저는 카메라를 지원하지 않습니다.");
      return;
    }
    setStartingCamera(true);
    setCameraError(null);
    try {
      const constraints: MediaStreamConstraints = {
        video: deviceId
          ? { deviceId: { exact: deviceId } }
          : { facingMode: "environment" },
        audio: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraActive(true);
      await loadDevices();
    } catch {
      setCameraError("카메라 접근에 실패했습니다. 권한과 HTTPS를 확인해주세요.");
      setCameraActive(false);
    } finally {
      setStartingCamera(false);
    }
  };

  const captureImage = async (angleLabel?: string) => {
    if (!videoRef.current) return;
    if (images.length >= STABLE_MAX_IMAGES) {
      setCameraError(`안정성을 위해 최대 ${STABLE_MAX_IMAGES}장까지 촬영할 수 있습니다.`);
      return;
    }

    const video = videoRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      setCameraError("카메라가 아직 준비되지 않았습니다.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setCameraError("캡처에 실패했습니다.");
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.92)
    );

    if (!blob) {
      setCameraError("캡처에 실패했습니다.");
      return;
    }

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const file = new File([blob], `capture-${Date.now()}.jpg`, {
      type: "image/jpeg",
    });
    const url = URL.createObjectURL(blob);

    setCaptured((prev) => [...prev, { id, file, url, angleLabel }]);
  };

  const resetWizard = () => {
    setWizardOpen(false);
    setWizardStep(1);
    setItemNo("");
    setName("");
    setPrice("");
    setBarcd("");
    setCaptured((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.url));
      return [];
    });
    if (cameraActive) stopCamera();
  };

  const wizardShoot = async () => {
    const nextIdx = Math.min(captured.length, WIZARD_ANGLES.length - 1);
    const angle = WIZARD_ANGLES[nextIdx];
    setShutterFlash(true);
    setTimeout(() => setShutterFlash(false), 180);
    await captureImage(angle.label);
  };

  const removeCapture = (id: string) => {
    setCaptured((prev) => {
      const target = prev.find((img) => img.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((img) => img.id !== id);
    });
  };

  const clearCaptures = () => {
    setCaptured((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.url));
      return [];
    });
  };

  useEffect(() => {
    capturedRef.current = captured;
  }, [captured]);

  useEffect(() => {
    loadDevices();
    return () => {
      stopCamera(false);
      capturedRef.current.forEach((img) => URL.revokeObjectURL(img.url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!cameraActive) return;
    if (selectedDeviceId) {
      startCamera(selectedDeviceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeviceId]);

  useEffect(() => {
    if (!detail) return;
    setDetailForm({
      product_name: detail.product_name || "",
      barcd: detail.barcd || "",
      price: detail.price != null ? String(detail.price) : "",
      stock: detail.stock != null ? String(detail.stock) : "",
      is_discounted: detail.is_discounted ?? false,
      discount_rate: detail.discount_rate != null ? String(detail.discount_rate) : "",
      discount_amount: detail.discount_amount != null ? String(detail.discount_amount) : "",
    });
  }, [detail]);

  // Hide ghost rows: products with no name AND no item_no are stale DB residue (no image, no info)
  const visibleProducts = (data?.products || []).filter(
    (p) => (p.name || "").trim().length > 0 || (p.item_no || "").trim().length > 0
  );

  const filteredMobileProducts = visibleProducts.filter((p) => {
    const q = wizardQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) || p.item_no.toLowerCase().includes(q)
    );
  });

  const [failedListImages, setFailedListImages] = useState<Record<string, true>>({});
  const markListImageFailed = (key: string) =>
    setFailedListImages((prev) => (prev[key] ? prev : { ...prev, [key]: true }));

  // Mobile swipe-left-to-delete: only one card stays revealed at a time.
  const SWIPE_REVEAL_PX = 88;
  const SWIPE_TRIGGER_PX = 40;
  const [swipedItemNo, setSwipedItemNo] = useState<string | null>(null);
  useEffect(() => {
    setSwipedItemNo(null);
  }, [wizardQuery]);
  const swipeRef = useRef<{ itemNo: string; startX: number; dx: number; locked: boolean } | null>(
    null
  );
  const onSwipeStart = (itemNo: string, clientX: number) => {
    swipeRef.current = { itemNo, startX: clientX, dx: 0, locked: false };
  };
  const onSwipeMove = (clientX: number) => {
    const s = swipeRef.current;
    if (!s) return;
    const dx = clientX - s.startX;
    s.dx = dx;
    if (!s.locked && Math.abs(dx) > 6) s.locked = true;
  };
  const onSwipeEnd = () => {
    const s = swipeRef.current;
    swipeRef.current = null;
    if (!s) return;
    if (s.dx < -SWIPE_TRIGGER_PX) {
      setSwipedItemNo(s.itemNo);
    } else if (s.dx > SWIPE_TRIGGER_PX) {
      setSwipedItemNo(null);
    }
  };

  const canWizardNext1 =
    name.trim().length > 0 &&
    itemNo.trim().length > 0 &&
    hasValidPrice;
  const canWizardSubmit = images.length >= MIN_IMAGES;

  return (
    <>
    <div className="hidden md:block max-w-5xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">상품 등록 (카메라)</h2>
        <a
          href="/api/db-viewer"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center px-3 py-2 rounded-lg text-sm font-medium border border-[var(--color-border)] bg-white hover:bg-[var(--color-bg-muted)]"
        >
          DB UI 열기
        </a>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <div className="space-y-6">
          <div className="bg-white border border-[var(--color-border)] rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold">카메라 미리보기</h3>
              <div className="flex items-center gap-2">
                {devices.length > 1 && (
                  <select
                    value={selectedDeviceId}
                    onChange={(e) => setSelectedDeviceId(e.target.value)}
                    className="border border-[var(--color-border)] rounded-lg px-2 py-1 text-sm"
                  >
                    {devices.map((device, idx) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `카메라 ${idx + 1}`}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  onClick={() => (cameraActive ? stopCamera() : startCamera(selectedDeviceId || undefined))}
                  className="px-3 py-1.5 rounded-lg text-sm bg-[var(--color-primary)] text-white"
                  disabled={startingCamera}
                >
                  {cameraActive ? "카메라 종료" : "카메라 시작"}
                </button>
              </div>
            </div>

            <div className="relative w-full aspect-video bg-[var(--color-bg-muted)] rounded-lg overflow-hidden">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover"
              />
              {!cameraActive && (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
                  카메라를 시작하면 화면이 표시됩니다.
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void captureImage()}
                disabled={!cameraActive || startingCamera}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white disabled:opacity-50"
              >
                촬영
              </button>
              <button
                type="button"
                onClick={clearCaptures}
                disabled={captured.length === 0}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-[var(--color-border)] disabled:opacity-50"
              >
                전체 삭제
              </button>
              <span className="text-sm text-[var(--color-text-muted)]">
                {captured.length}장 (최소 {MIN_IMAGES}장, 권장 최대 {RECOMMENDED_MAX_IMAGES}장)
              </span>
            </div>

            {cameraError && (
              <p className="text-sm text-[var(--color-danger)]">{cameraError}</p>
            )}
            <p className="text-xs text-[var(--color-text-muted)]">
              HTTPS(또는 localhost) 환경에서 카메라 권한이 필요합니다.
            </p>
          </div>

          <div className="bg-white border border-[var(--color-border)] rounded-xl p-6 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">촬영 이미지</h3>
              {captured.length > 0 && (
                <span className="text-xs text-[var(--color-text-muted)]">
                  클릭해서 개별 삭제 가능
                </span>
              )}
            </div>
            {captured.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                아직 촬영된 이미지가 없습니다.
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {captured.map((img) => (
                  <div key={img.id} className="relative group">
                    <img
                      src={img.url}
                      alt="captured"
                      className="w-full h-28 object-cover rounded-lg border border-[var(--color-border)]"
                    />
                    <button
                      type="button"
                      onClick={() => removeCapture(img.id)}
                      className="absolute top-2 right-2 px-2 py-1 text-xs rounded bg-[var(--color-danger)] text-white opacity-0 group-hover:opacity-100 transition"
                    >
                      삭제
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white border border-[var(--color-border)] rounded-xl p-6 space-y-4">
            <h3 className="font-semibold">상품 정보</h3>
            <div>
              <label className="block text-sm font-medium mb-1">상품번호</label>
              <input
                type="text"
                value={itemNo}
                onChange={(e) => setItemNo(e.target.value)}
                placeholder="상품번호 (숫자)"
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">상품명</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="상품명"
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">가격</label>
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="가격"
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">바코드</label>
              <input
                type="text"
                value={barcd}
                onChange={(e) => setBarcd(e.target.value)}
                placeholder="바코드 (선택)"
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              />
            </div>

            <button
              onClick={() => mutation.mutate()}
              disabled={!canSubmit || mutation.isPending}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-primary)] text-white disabled:opacity-50"
            >
              {mutation.isPending ? "등록 중..." : "상품 등록"}
            </button>

            {!canSubmit && (
              <p className="text-xs text-[var(--color-text-muted)]">
                상품 정보 입력 후 최소 {MIN_IMAGES}장을 촬영해주세요.
              </p>
            )}

            {mutation.isError && (
              <p className="text-sm text-[var(--color-danger)]">
                {(mutation.error as Error).message}
              </p>
            )}
            {mutation.isSuccess && (
              <p className="text-sm text-[var(--color-success)]">
                상품이 성공적으로 등록되었습니다!
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white border border-[var(--color-border)] rounded-xl p-6">
        <h3 className="font-semibold mb-3">상품 목록</h3>
        {isLoading ? (
          <p className="text-sm text-[var(--color-text-muted)]">Loading...</p>
        ) : visibleProducts.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">등록된 상품이 없습니다.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] max-h-[520px] overflow-y-auto">
            {visibleProducts.map((p) => {
              const imgKey = p.item_no || p.name;
              const showImage = Boolean(p.picture) && !failedListImages[imgKey];
              return (
              <li
                key={p.item_no}
                className="py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-sm"
              >
                <div className="flex items-center gap-3">
                  {showImage ? (
                    <img
                      src={p.picture as string}
                      alt={p.name}
                      className="w-12 h-12 rounded-lg object-cover flex-shrink-0 bg-gray-100"
                      onError={() => markListImageFailed(imgKey)}
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-[var(--color-primary-light)] text-[var(--color-primary)] font-bold flex items-center justify-center flex-shrink-0">
                      {(p.name || "·").slice(0, 1)}
                    </div>
                  )}
                  <div>
                    <button
                      type="button"
                      onClick={() => setSelectedItemNo(p.item_no)}
                      className="font-medium hover:underline text-left"
                    >
                      {p.name}
                    </button>
                    <p className="text-xs text-[var(--color-text-muted)]">상품번호: {p.item_no}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    className="px-2 py-1 rounded bg-[var(--color-danger)] text-white text-xs"
                    onClick={() => setConfirmDelete({ itemNo: p.item_no, name: p.name })}
                    disabled={deleteMutation.isPending}
                  >
                    삭제
                  </button>
                </div>
              </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>

    {/* ====================== MOBILE (below md:) ====================== */}
    <div className="md:hidden h-[100dvh] flex flex-col bg-slate-50">
      <div className="px-[18px] pt-[18px] pb-3.5 bg-white border-b border-[var(--color-border)]">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-xl font-extrabold text-slate-900 tracking-tight">
              상품 관리
            </div>
            <div className="text-[11.5px] text-slate-500 mt-0.5">
              {visibleProducts.length}개 등록 · FAISS 인덱스 동기화
            </div>
          </div>
          <button
            onClick={() => {
              setWizardOpen(true);
              setWizardStep(1);
            }}
            className="px-3.5 py-2.5 rounded-[10px] border-0 text-white text-[13px] font-bold flex items-center gap-1.5"
            style={{
              background: "linear-gradient(180deg, #fb923c, #f97316)",
              boxShadow: "0 4px 14px rgba(249,115,22,0.36)",
            }}
          >
            <span className="text-base leading-none">+</span> 등록
          </button>
        </div>
        <div className="relative">
          <input
            value={wizardQuery}
            onChange={(e) => setWizardQuery(e.target.value)}
            placeholder="상품명 · 상품번호 검색"
            className="w-full pl-9 pr-3 py-2.5 border border-[var(--color-border)] rounded-[10px] text-sm bg-slate-50 outline-none"
          />
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">
            ⌕
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3.5 pb-10 pt-2">
        {isLoading ? (
          <p className="text-sm text-slate-400 p-6 text-center">로딩 중...</p>
        ) : filteredMobileProducts.length === 0 ? (
          <div className="py-16 text-center text-slate-400">
            <div className="text-4xl mb-2">📦</div>
            <div className="text-sm">일치하는 상품이 없습니다</div>
          </div>
        ) : (
          filteredMobileProducts.map((p) => {
            const imgKey = p.item_no || p.name;
            const showImage = Boolean(p.picture) && !failedListImages[imgKey];
            const embeddingCount = p.embedding_count ?? 0;
            const isHealthy = embeddingCount >= 5;
            const isSwiped = swipedItemNo === p.item_no;
            return (
              <div
                key={p.item_no}
                className="mt-2 relative overflow-hidden rounded-[14px]"
                style={{ touchAction: "pan-y" }}
              >
                {/* Delete reveal layer (behind card) */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSwipedItemNo(null);
                    setConfirmDelete({ itemNo: p.item_no, name: p.name });
                  }}
                  className="absolute inset-y-0 right-0 w-[88px] bg-[var(--color-danger)] text-white text-sm font-bold flex items-center justify-center"
                  aria-label={`${p.name} 삭제`}
                  tabIndex={isSwiped ? 0 : -1}
                >
                  삭제
                </button>

                {/* Card (swipes left to reveal delete) */}
                <div
                  onClick={() => {
                    if (isSwiped) {
                      setSwipedItemNo(null);
                      return;
                    }
                    setSelectedItemNo(p.item_no);
                  }}
                  onTouchStart={(e) => onSwipeStart(p.item_no, e.touches[0].clientX)}
                  onTouchMove={(e) => onSwipeMove(e.touches[0].clientX)}
                  onTouchEnd={onSwipeEnd}
                  className="relative bg-white border border-[var(--color-border)] rounded-[14px] p-3.5 flex items-center gap-3 cursor-pointer"
                  style={{
                    transform: `translateX(${isSwiped ? -SWIPE_REVEAL_PX : 0}px)`,
                    transition: "transform 220ms cubic-bezier(0.16, 1, 0.3, 1)",
                  }}
                >
                  {showImage ? (
                    <img
                      src={p.picture as string}
                      alt={p.name}
                      className="w-[52px] h-[52px] rounded-[10px] object-cover bg-slate-100 flex-shrink-0"
                      onError={() => markListImageFailed(imgKey)}
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-[52px] h-[52px] rounded-[10px] bg-[var(--color-primary-light)] text-[var(--color-primary)] font-bold flex items-center justify-center flex-shrink-0">
                      {(p.name || "·").slice(0, 1)}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-[14.5px] font-bold text-slate-900 truncate">
                      {p.name}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[11.5px] text-slate-500 font-mono truncate">
                        {p.item_no}
                      </span>
                      <span
                        className={`inline-flex items-center px-1.5 py-[1px] rounded-full text-[10px] font-bold flex-shrink-0 ${
                          isHealthy
                            ? "bg-slate-100 text-slate-600"
                            : "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                        }`}
                        title={isHealthy ? "충분한 학습 데이터" : "학습 데이터 부족"}
                      >
                        🖼 학습 {embeddingCount}장
                      </span>
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-400 flex-shrink-0">
                    {isSwiped ? "← 닫기" : "탭 · 편집"}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ==== WIZARD OVERLAY ==== */}
      {wizardOpen && (
        <MobileWizard
          step={wizardStep}
          setStep={setWizardStep}
          itemNo={itemNo}
          setItemNo={setItemNo}
          name={name}
          setName={setName}
          price={price}
          setPrice={setPrice}
          barcd={barcd}
          setBarcd={setBarcd}
          videoRef={videoRef}
          cameraActive={cameraActive}
          startingCamera={startingCamera}
          cameraError={cameraError}
          startCamera={startCamera}
          stopCamera={stopCamera}
          captured={captured}
          shoot={wizardShoot}
          removeCapture={removeCapture}
          shutterFlash={shutterFlash}
          canNext1={canWizardNext1}
          canSubmit={canWizardSubmit}
          submitting={mutation.isPending}
          uploadError={mutation.isError ? (mutation.error as Error).message : null}
          uploadSuccess={mutation.isSuccess}
          onSubmit={() => mutation.mutate()}
          onClose={resetWizard}
        />
      )}
    </div>

    {/* ====================== SHARED MODALS ====================== */}
    {selectedItemNo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => {
              if (!updateDetailMutation.isPending) {
                setSelectedItemNo(null);
                setDetailForm(null);
              }
            }}
          />
          <div className="relative w-full max-w-lg rounded-xl bg-white border border-[var(--color-border)] p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h4 className="text-lg font-semibold">상품 상세 수정</h4>
                <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                  상품번호: {selectedItemNo}
                </p>
              </div>
              <button
                type="button"
                className="px-2 py-1 text-sm rounded border border-[var(--color-border)]"
                onClick={() => {
                  if (!updateDetailMutation.isPending) {
                    setSelectedItemNo(null);
                    setDetailForm(null);
                  }
                }}
              >
                닫기
              </button>
            </div>

            {isDetailLoading ? (
              <p className="text-sm text-[var(--color-text-muted)] py-8 text-center">로딩 중...</p>
            ) : isDetailError || !detail || !detailForm ? (
              <p className="text-sm text-[var(--color-danger)] py-8 text-center">
                상품 상세 정보를 불러오지 못했습니다.
              </p>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium mb-1">상품명</label>
                  <input
                    type="text"
                    value={detailForm.product_name}
                    onChange={(e) => setDetailForm((prev) => (prev ? { ...prev, product_name: e.target.value } : prev))}
                    className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">바코드</label>
                  <input
                    type="text"
                    value={detailForm.barcd}
                    onChange={(e) => setDetailForm((prev) => (prev ? { ...prev, barcd: e.target.value } : prev))}
                    className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1">가격</label>
                    <input
                      type="number"
                      min={1}
                      value={detailForm.price}
                      onChange={(e) =>
                        setDetailForm((prev) => {
                          if (!prev) return prev;
                          const nextPrice = e.target.value;
                          const next = { ...prev, price: nextPrice };
                          const priceValue = Number(nextPrice);
                          const rateValue = Number(prev.discount_rate);
                          if (
                            Number.isFinite(priceValue) &&
                            priceValue > 0 &&
                            Number.isFinite(rateValue) &&
                            rateValue >= 0
                          ) {
                            next.discount_amount = String(toDiscountedPrice(priceValue, rateValue));
                          }
                          return next;
                        })
                      }
                      className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium mb-1">
                      재고{detail.available_fields.stock ? "" : " (DB 컬럼 없음)"}
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={detailForm.stock}
                      disabled={!detail.available_fields.stock}
                      onChange={(e) => setDetailForm((prev) => (prev ? { ...prev, stock: e.target.value } : prev))}
                      className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm disabled:bg-gray-100 disabled:text-gray-400"
                    />
                  </div>
                </div>

                <div className="rounded-lg border border-[var(--color-border)] p-3 space-y-3">
                  <p className="text-xs font-semibold">
                    할인 정보{detail.available_fields.discount ? "" : " (DB 테이블 없음)"}
                  </p>
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={detailForm.is_discounted}
                      disabled={!detail.available_fields.discount}
                      onChange={(e) =>
                        setDetailForm((prev) => (prev ? { ...prev, is_discounted: e.target.checked } : prev))
                      }
                    />
                    할인 적용
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium mb-1">할인율(%)</label>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={detailForm.discount_rate}
                        disabled={!detail.available_fields.discount}
                        onChange={(e) =>
                          setDetailForm((prev) => {
                            if (!prev) return prev;
                            const nextRate = e.target.value;
                            const next = { ...prev, discount_rate: nextRate };
                            const priceValue = Number(prev.price);
                            const rateValue = Number(nextRate);
                            if (
                              Number.isFinite(priceValue) &&
                              priceValue > 0 &&
                              Number.isFinite(rateValue) &&
                              rateValue >= 0
                            ) {
                              next.discount_amount = String(toDiscountedPrice(priceValue, rateValue));
                            } else if (nextRate.trim() === "") {
                              next.discount_amount = "";
                            }
                            return next;
                          })
                        }
                        className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm disabled:bg-gray-100 disabled:text-gray-400"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">할인금액(원)</label>
                      <input
                        type="number"
                        min={0}
                        value={detailForm.discount_amount}
                        disabled={!detail.available_fields.discount}
                        onChange={(e) =>
                          setDetailForm((prev) => {
                            if (!prev) return prev;
                            const nextAmount = e.target.value;
                            const next = { ...prev, discount_amount: nextAmount };
                            const priceValue = Number(prev.price);
                            const amountValue = Number(nextAmount);
                            if (
                              Number.isFinite(priceValue) &&
                              priceValue > 0 &&
                              Number.isFinite(amountValue) &&
                              amountValue >= 0
                            ) {
                              next.discount_rate = formatRateInput(toDiscountRate(priceValue, amountValue));
                            } else if (nextAmount.trim() === "") {
                              next.discount_rate = "";
                            }
                            return next;
                          })
                        }
                        className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-sm disabled:bg-gray-100 disabled:text-gray-400"
                      />
                    </div>
                  </div>
                </div>

                {updateDetailMutation.isError && (
                  <p className="text-sm text-[var(--color-danger)]">
                    {(updateDetailMutation.error as Error).message}
                  </p>
                )}

                {updateDetailMutation.isSuccess && (
                  <p className="text-sm text-[var(--color-success)]">
                    상품 정보가 저장되었습니다.
                  </p>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (!updateDetailMutation.isPending) {
                        setSelectedItemNo(null);
                        setDetailForm(null);
                      }
                    }}
                    className="px-3 py-2 rounded-lg text-sm border border-[var(--color-border)] disabled:opacity-50"
                    disabled={updateDetailMutation.isPending}
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    onClick={() => updateDetailMutation.mutate()}
                    className="px-3 py-2 rounded-lg text-sm bg-[var(--color-primary)] text-white disabled:opacity-50"
                    disabled={updateDetailMutation.isPending}
                  >
                    {updateDetailMutation.isPending ? "저장 중..." : "저장"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => {
              if (!deleteMutation.isPending) setConfirmDelete(null);
            }}
          />
          <div className="relative w-full max-w-sm rounded-xl bg-white border border-[var(--color-border)] p-6 shadow-xl">
            <h4 className="text-base font-semibold mb-2">상품 삭제 확인</h4>
            <p className="text-sm text-[var(--color-text-secondary)]">
              &quot;{confirmDelete.name}&quot; 상품을 정말 삭제하시겠습니까?
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                disabled={deleteMutation.isPending}
                className="px-3 py-2 rounded-lg text-sm border border-[var(--color-border)] disabled:opacity-50"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteMutation.mutate(confirmDelete.itemNo);
                  setConfirmDelete(null);
                }}
                disabled={deleteMutation.isPending}
                className="px-3 py-2 rounded-lg text-sm bg-[var(--color-danger)] text-white disabled:opacity-50"
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

interface MobileWizardProps {
  step: 1 | 2 | 3;
  setStep: (s: 1 | 2 | 3) => void;
  itemNo: string;
  setItemNo: (v: string) => void;
  name: string;
  setName: (v: string) => void;
  price: string;
  setPrice: (v: string) => void;
  barcd: string;
  setBarcd: (v: string) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  cameraActive: boolean;
  startingCamera: boolean;
  cameraError: string | null;
  startCamera: (deviceId?: string) => Promise<void>;
  stopCamera: (updateState?: boolean) => void;
  captured: CapturedImage[];
  shoot: () => Promise<void>;
  removeCapture: (id: string) => void;
  shutterFlash: boolean;
  canNext1: boolean;
  canSubmit: boolean;
  submitting: boolean;
  uploadError: string | null;
  uploadSuccess: boolean;
  onSubmit: () => void;
  onClose: () => void;
}

function MobileWizard(props: MobileWizardProps) {
  const {
    step,
    setStep,
    itemNo,
    setItemNo,
    name,
    setName,
    price,
    setPrice,
    barcd,
    setBarcd,
    videoRef,
    cameraActive,
    startingCamera,
    cameraError,
    startCamera,
    captured,
    shoot,
    removeCapture,
    shutterFlash,
    canNext1,
    canSubmit,
    submitting,
    uploadError,
    uploadSuccess,
    onSubmit,
    onClose,
  } = props;

  const n = captured.length;
  // Ring fills against the stable max (10) so users see room to keep capturing.
  const pct = Math.min(100, (n / STABLE_MAX_IMAGES) * 100);
  const currentAngle = WIZARD_ANGLES[Math.min(n, WIZARD_ANGLES.length - 1)];

  // Milestones: under min → orange (need more) / min reached → amber (ok) / reco reached → green (ideal).
  const ringStage: "under" | "min" | "reco" =
    n >= RECOMMENDED_MAX_IMAGES ? "reco" : n >= MIN_IMAGES ? "min" : "under";
  const ringStroke =
    ringStage === "reco" ? "#22c55e" : ringStage === "min" ? "#fbbf24" : "#f97316";
  const ringStatus =
    ringStage === "reco"
      ? "충분합니다 · 더 찍어도 좋아요"
      : ringStage === "min"
        ? `권장까지 ${RECOMMENDED_MAX_IMAGES - n}장 더`
        : `최소까지 ${MIN_IMAGES - n}장 더`;
  // Tick angles for milestone markers on the ring (rotated -90deg, so 0deg = top).
  const ringTicks = [MIN_IMAGES, RECOMMENDED_MAX_IMAGES].map((threshold) => ({
    threshold,
    angle: (threshold / STABLE_MAX_IMAGES) * 360,
    reached: n >= threshold,
  }));

  useEffect(() => {
    if (step === 2 && !cameraActive && !startingCamera) {
      void startCamera();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const StepIndicator = () => (
    <div className="flex items-center gap-1.5 px-[18px] py-3.5 bg-white border-b border-[var(--color-border)]">
      {[1, 2, 3].map((n) => (
        <div key={n} className="flex items-center gap-1.5 flex-1">
          <div className="flex items-center gap-1.5">
            <div
              className={`w-6 h-6 rounded-full text-[11px] font-extrabold flex items-center justify-center ${
                n === step
                  ? "bg-[var(--color-primary)] text-white"
                  : n < step
                    ? "bg-orange-200 text-orange-900"
                    : "bg-slate-200 text-slate-400"
              }`}
            >
              {n < step ? "✓" : n}
            </div>
            <div
              className={`text-xs ${
                n === step ? "font-bold text-slate-900" : "font-medium text-slate-400"
              }`}
            >
              {n === 1 ? "정보" : n === 2 ? "촬영" : "검토"}
            </div>
          </div>
          {n < 3 && (
            <div
              className={`flex-1 h-0.5 mx-1 ${
                n < step ? "bg-orange-200" : "bg-slate-200"
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[60] bg-slate-50 flex flex-col">
      {/* ---- STEP 1: INFO ---- */}
      {step === 1 && (
        <>
          <StepIndicator />
          <div className="flex-1 overflow-y-auto p-[18px] pb-28">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xl font-extrabold text-slate-900 tracking-tight">
                  상품 정보
                </div>
                <div className="text-[12.5px] text-slate-500 mt-1">
                  등록할 상품의 기본 정보를 입력하세요.
                </div>
              </div>
              <button onClick={onClose} className="w-8 h-8 rounded-full border border-slate-200 text-slate-500">
                ✕
              </button>
            </div>

            <div className="mt-5 flex flex-col gap-3">
              <Field label="상품명" required>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="예: 서울우유 900ml"
                  className={wizardInput}
                />
              </Field>
              <Field label="가격" required hint="원 단위 숫자만">
                <div className="relative">
                  <input
                    inputMode="decimal"
                    value={price}
                    onChange={(e) => setPrice(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="0"
                    className={`${wizardInput} pl-8`}
                  />
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[15px]">
                    ₩
                  </span>
                </div>
              </Field>
              <Field label="상품 번호" required hint="label 접두사로 사용됩니다 (예: 042_서울우유)">
                <input
                  inputMode="numeric"
                  value={itemNo}
                  onChange={(e) => setItemNo(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="042"
                  className={wizardInput}
                />
              </Field>
              <Field label="바코드" hint="선택 · 수동 입력">
                <input
                  value={barcd}
                  onChange={(e) => setBarcd(e.target.value)}
                  placeholder="8801234567890"
                  className={wizardInput}
                />
              </Field>
            </div>
          </div>
          <div className="absolute bottom-0 left-0 right-0 p-4 pb-6 bg-white border-t border-[var(--color-border)]">
            <button
              disabled={!canNext1}
              onClick={() => setStep(2)}
              className={`w-full py-3.5 rounded-xl text-[15px] font-bold text-white ${
                canNext1 ? "" : "bg-slate-200 text-slate-400"
              }`}
              style={
                canNext1
                  ? {
                      background: "linear-gradient(180deg, #fb923c, #f97316)",
                      boxShadow: "0 6px 18px rgba(249,115,22,0.36)",
                    }
                  : undefined
              }
            >
              다음 · 촬영
            </button>
          </div>
        </>
      )}

      {/* ---- STEP 2: CAPTURE ---- */}
      {step === 2 && (
        <div className="fixed inset-0 bg-black flex flex-col">
          {/* Camera video */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover"
          />
          <div
            className="absolute inset-0 opacity-60 pointer-events-none"
            style={{
              backgroundImage:
                "linear-gradient(rgba(148,163,184,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.05) 1px, transparent 1px)",
              backgroundSize: "40px 40px",
            }}
          />

          {/* Top bar */}
          <div className="relative z-[2] flex items-center justify-between px-3.5 pt-[60px]">
            <button onClick={() => setStep(1)} className={iconBtnDark}>
              ←
            </button>
            <div className="px-3.5 py-2 rounded-full bg-slate-900/60 backdrop-blur text-white text-xs font-bold">
              {name || "상품 등록"}
            </div>
            <div className="w-10" />
          </div>

          {/* Progress ring with MIN(3) / RECO(5) / MAX(10) milestones */}
          <div className="relative z-[2] mt-3 flex flex-col items-center">
            <div className="relative w-[64px] h-[64px]">
              <svg width="64" height="64" viewBox="0 0 64 64" style={{ transform: "rotate(-90deg)" }}>
                {/* Track */}
                <circle cx="32" cy="32" r="27" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="3" />
                {/* Filled arc */}
                <circle
                  cx="32"
                  cy="32"
                  r="27"
                  fill="none"
                  stroke={ringStroke}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={`${(pct / 100) * 2 * Math.PI * 27} 999`}
                  style={{ transition: "stroke 200ms, stroke-dasharray 220ms" }}
                />
                {/* Milestone tick markers (MIN, RECO) */}
                {ringTicks.map(({ threshold, angle, reached }) => {
                  const rad = (angle * Math.PI) / 180;
                  const cx = 32 + Math.cos(rad) * 27;
                  const cy = 32 + Math.sin(rad) * 27;
                  return (
                    <circle
                      key={threshold}
                      cx={cx}
                      cy={cy}
                      r="2.5"
                      fill={reached ? "#fff" : "rgba(255,255,255,0.4)"}
                      stroke="rgba(15,23,42,0.6)"
                      strokeWidth="0.5"
                    />
                  );
                })}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
                <span className="font-extrabold text-[15px] leading-none">{n}</span>
                <span className="text-[9px] text-slate-300 font-mono leading-tight mt-0.5">
                  /{STABLE_MAX_IMAGES}
                </span>
              </div>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] font-mono text-slate-300">
              <span className={n >= MIN_IMAGES ? "text-amber-300" : "text-slate-400"}>
                최소 {MIN_IMAGES}
              </span>
              <span className="text-slate-600">·</span>
              <span className={n >= RECOMMENDED_MAX_IMAGES ? "text-green-400" : "text-slate-400"}>
                권장 {RECOMMENDED_MAX_IMAGES}
              </span>
              <span className="text-slate-600">·</span>
              <span className="text-slate-400">최대 {STABLE_MAX_IMAGES}</span>
            </div>
            <div className="mt-1 text-[10.5px] font-semibold" style={{ color: ringStroke }}>
              {ringStatus}
            </div>
          </div>

          {/* Viewfinder + angle ghost */}
          <div className="relative z-[2] flex-1 flex items-center justify-center">
            <div className="relative w-60 h-60">
              <div
                className="absolute top-0 left-0 w-7 h-7 rounded-tl-xl"
                style={{
                  borderTop: "3px solid var(--color-primary)",
                  borderLeft: "3px solid var(--color-primary)",
                  boxShadow: "0 0 18px rgba(249,115,22,0.5)",
                }}
              />
              <div
                className="absolute top-0 right-0 w-7 h-7 rounded-tr-xl"
                style={{
                  borderTop: "3px solid var(--color-primary)",
                  borderRight: "3px solid var(--color-primary)",
                  boxShadow: "0 0 18px rgba(249,115,22,0.5)",
                }}
              />
              <div
                className="absolute bottom-0 left-0 w-7 h-7 rounded-bl-xl"
                style={{
                  borderBottom: "3px solid var(--color-primary)",
                  borderLeft: "3px solid var(--color-primary)",
                  boxShadow: "0 0 18px rgba(249,115,22,0.5)",
                }}
              />
              <div
                className="absolute bottom-0 right-0 w-7 h-7 rounded-br-xl"
                style={{
                  borderBottom: "3px solid var(--color-primary)",
                  borderRight: "3px solid var(--color-primary)",
                  boxShadow: "0 0 18px rgba(249,115,22,0.5)",
                }}
              />
              {/* Ghost silhouette */}
              <div className="absolute inset-9 flex items-center justify-center text-[120px] leading-none text-orange-500/30">
                {currentAngle.icon}
              </div>
              {/* Angle hint pill */}
              <div className="absolute -top-7 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-full bg-[var(--color-primary)]/95 text-white text-[11px] font-bold whitespace-nowrap">
                {n < WIZARD_ANGLES.length ? `다음: ${currentAngle.label}` : "자유 각도 추가"}
              </div>
            </div>
          </div>

          {/* Angle chips */}
          <div className="relative z-[2] px-3.5 pb-2.5 flex gap-1.5 overflow-x-auto">
            {WIZARD_ANGLES.map((a, i) => {
              const done = captured.some((c) => c.angleLabel === a.label);
              const isCurrent = i === n && n < WIZARD_ANGLES.length;
              return (
                <div
                  key={a.key}
                  className="px-2.5 py-1 rounded-full border text-[11px] font-semibold whitespace-nowrap flex items-center gap-1"
                  style={{
                    background: done
                      ? "rgba(34,197,94,0.18)"
                      : isCurrent
                        ? "rgba(249,115,22,0.22)"
                        : "rgba(255,255,255,0.08)",
                    borderColor: done
                      ? "rgba(34,197,94,0.45)"
                      : isCurrent
                        ? "rgba(249,115,22,0.6)"
                        : "rgba(255,255,255,0.15)",
                    color: done ? "#86efac" : isCurrent ? "#fdba74" : "#94a3b8",
                  }}
                >
                  {done && "✓ "}
                  {a.label}
                </div>
              );
            })}
          </div>

          {/* Thumbnail strip */}
          {captured.length > 0 && (
            <div className="relative z-[2] px-3.5 pb-2 flex gap-1.5 overflow-x-auto">
              {captured.map((c) => (
                <div
                  key={c.id}
                  className="relative w-[46px] h-[46px] rounded-lg border-2 border-white/20 flex-shrink-0 overflow-hidden"
                >
                  <img src={c.url} alt="capture" className="w-full h-full object-cover" />
                  <button
                    onClick={() => removeCapture(c.id)}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[var(--color-danger)] text-white text-[10px] flex items-center justify-center"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Bottom controls */}
          <div className="relative z-[2] flex items-center justify-between gap-2.5 px-4 pb-6">
            <button onClick={() => setStep(1)} className={`${iconBtnDark} w-11 h-11`}>
              ‹
            </button>
            <button
              onClick={() => void shoot()}
              disabled={!cameraActive || n >= STABLE_MAX_IMAGES}
              className="w-[68px] h-[68px] rounded-full border-[4px] border-white/50 shadow-[0_4px_16px_rgba(0,0,0,0.4)]"
              style={{
                background: n >= STABLE_MAX_IMAGES ? "#475569" : "#fff",
                cursor:
                  n >= STABLE_MAX_IMAGES || !cameraActive ? "not-allowed" : "pointer",
              }}
            />
            <button
              onClick={() => setStep(3)}
              disabled={!canSubmit}
              className="px-3.5 py-2.5 rounded-xl text-[13px] font-bold"
              style={{
                background: canSubmit ? "var(--color-primary)" : "rgba(255,255,255,0.1)",
                color: canSubmit ? "#fff" : "#64748b",
              }}
            >
              검토 →
            </button>
          </div>

          {cameraError && (
            <div className="absolute top-[120px] left-3 right-3 z-[3] p-3 rounded-lg bg-[var(--color-danger)] text-white text-xs">
              {cameraError}
            </div>
          )}

          {shutterFlash && (
            <div className="absolute inset-0 bg-white/85 z-[5] pointer-events-none" />
          )}
        </div>
      )}

      {/* ---- STEP 3: REVIEW ---- */}
      {step === 3 && (
        <>
          <StepIndicator />
          <div className="flex-1 overflow-y-auto p-[18px] pb-32">
            <div className="text-xl font-extrabold text-slate-900">검토 후 등록</div>
            <div className="text-[12.5px] text-slate-500 mt-1">
              정보와 촬영본을 최종 확인하세요.
            </div>

            <div className="mt-4 bg-white border border-[var(--color-border)] rounded-[14px] p-4">
              <div className="flex justify-between items-start">
                <div>
                  <div className="text-[15px] font-bold text-slate-900">{name}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5 font-mono">
                    item_no: {itemNo}
                    {barcd && ` · ${barcd}`}
                  </div>
                </div>
                <div className="text-[17px] font-extrabold text-[var(--color-primary)]">
                  ₩{Number(price).toLocaleString()}
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div className="text-[13px] font-bold text-slate-900">
                촬영 이미지 <span className="text-[var(--color-primary)]">{captured.length}</span>
                <span className="text-slate-400">/{STABLE_MAX_IMAGES}</span>
              </div>
              {!submitting && (
                <button
                  onClick={() => setStep(2)}
                  className="px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] bg-white text-xs font-semibold text-slate-700"
                >
                  다시 촬영
                </button>
              )}
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {captured.map((c) => (
                <div
                  key={c.id}
                  className="relative aspect-square rounded-[10px] border border-[var(--color-border)] overflow-hidden"
                >
                  <img src={c.url} alt="capture" className="w-full h-full object-cover" />
                  {c.angleLabel && (
                    <div className="absolute bottom-1 left-1 text-[10px] text-slate-700 bg-white/90 px-1.5 py-0.5 rounded font-semibold">
                      {c.angleLabel}
                    </div>
                  )}
                  {!submitting && (
                    <button
                      onClick={() => removeCapture(c.id)}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-slate-900/70 text-white text-[11px]"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>

            {submitting && (
              <div className="mt-5 bg-white border border-[var(--color-border)] rounded-[14px] p-4">
                <div className="flex justify-between items-center mb-2">
                  <div className="text-[13px] font-bold text-slate-900">등록 중…</div>
                  <div
                    className="w-3 h-3 border-2 border-slate-200 border-t-[var(--color-primary)] rounded-full animate-spin"
                  />
                </div>
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full animate-pulse"
                    style={{
                      width: "100%",
                      background: "linear-gradient(90deg, #fb923c, #f97316)",
                    }}
                  />
                </div>
                <div className="mt-2 text-[11px] text-slate-500">
                  DINO 0.7 + CLIP 0.3 가중치로 FAISS 인덱스 증분 반영 중 (수 초 소요)
                </div>
              </div>
            )}

            {uploadSuccess && (
              <div className="mt-5 bg-green-50 border border-green-300 rounded-[14px] p-4 text-center">
                <div className="text-[36px]">✓</div>
                <div className="text-[15px] font-bold text-green-800">
                  등록이 완료되었습니다
                </div>
                <div className="text-[12px] text-green-700 mt-1">
                  {itemNo}_{name} · {captured.length}장 · FAISS 반영됨
                </div>
              </div>
            )}

            {uploadError && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-xl p-3 text-[var(--color-danger)] text-xs">
                ⚠ {uploadError} · 촬영본은 보존되었습니다.
              </div>
            )}
          </div>
          <div className="absolute bottom-0 left-0 right-0 p-4 pb-6 bg-white border-t border-[var(--color-border)] flex gap-2">
            {uploadSuccess ? (
              <button
                onClick={onClose}
                className="flex-1 py-3.5 rounded-xl text-[15px] font-bold text-white"
                style={{
                  background: "linear-gradient(180deg, #fb923c, #f97316)",
                  boxShadow: "0 6px 18px rgba(249,115,22,0.36)",
                }}
              >
                완료 · 목록으로
              </button>
            ) : submitting ? (
              <button
                disabled
                className="flex-1 py-3.5 rounded-xl text-[15px] font-bold bg-slate-200 text-slate-400"
              >
                등록 중…
              </button>
            ) : (
              <>
                <button
                  onClick={() => setStep(2)}
                  className="flex-1 py-3.5 rounded-xl border border-[var(--color-border)] text-slate-600 text-sm font-semibold"
                >
                  ← 뒤로
                </button>
                <button
                  onClick={onSubmit}
                  disabled={!canSubmit}
                  className="flex-[2] py-3.5 rounded-xl text-[15px] font-bold text-white disabled:bg-slate-200 disabled:text-slate-400"
                  style={
                    canSubmit
                      ? {
                          background: "linear-gradient(180deg, #fb923c, #f97316)",
                          boxShadow: "0 6px 18px rgba(249,115,22,0.36)",
                        }
                      : undefined
                  }
                >
                  등록 · {captured.length}장
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1">
        {label}
        {required && <span className="text-[var(--color-primary)]">*</span>}
      </div>
      {children}
      {hint && <div className="text-[10.5px] text-slate-400 mt-1">{hint}</div>}
    </label>
  );
}

const wizardInput =
  "w-full px-3.5 py-3 border border-[var(--color-border)] rounded-[10px] text-[15px] text-slate-900 bg-white outline-none";
const iconBtnDark =
  "w-10 h-10 rounded-full border-0 bg-slate-900/60 backdrop-blur text-white text-lg";
