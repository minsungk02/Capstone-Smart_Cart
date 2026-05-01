import { create } from "zustand";

interface UIState {
  isChatbotOpen: boolean;
  setChatbotOpen: (open: boolean) => void;
  toggleChatbot: () => void;
  checkoutSheetH: number;
  setCheckoutSheetH: (h: number) => void;
}

export const useUIStore = create<UIState>((set) => ({
  isChatbotOpen: false,
  setChatbotOpen: (open) => set({ isChatbotOpen: open }),
  toggleChatbot: () => set((s) => ({ isChatbotOpen: !s.isChatbotOpen })),
  checkoutSheetH: 360,
  setCheckoutSheetH: (h) => set({ checkoutSheetH: h }),
}));
