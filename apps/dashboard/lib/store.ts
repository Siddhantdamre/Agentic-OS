import { create } from 'zustand';

interface OnboardingState {
  step: number;
  businessName: string;
  teamSize: number;
  businessType: string;
  selectedChannels: string[];
  
  setBusinessName: (name: string) => void;
  setTeamSize: (size: number) => void;
  setBusinessType: (type: string) => void;
  toggleChannel: (channel: string) => void;
  setStep: (step: number) => void;
  hydrateFromServer: (partial: {
    businessName?: string;
    teamSize?: number;
    businessType?: string;
    selectedChannels?: string[];
  }) => void;
  reset: () => void;
}

export const useOnboardingStore = create<OnboardingState>((set) => ({
  step: 1,
  businessName: '',
  teamSize: 5,
  businessType: '',
  selectedChannels: ['whatsapp', 'email'],

  setBusinessName: (businessName) => set({ businessName }),
  setTeamSize: (teamSize) => set({ teamSize }),
  setBusinessType: (businessType) => set({ businessType }),
  toggleChannel: (channel) =>
    set((state) => ({
      selectedChannels: state.selectedChannels.includes(channel)
        ? state.selectedChannels.filter((c) => c !== channel)
        : [...state.selectedChannels, channel],
    })),
  setStep: (step) => set({ step }),
  hydrateFromServer: (partial) =>
    set((state) => ({
      businessName: state.businessName || partial.businessName || '',
      teamSize: partial.teamSize ?? state.teamSize,
      businessType: state.businessType || partial.businessType || '',
      selectedChannels:
        partial.selectedChannels && partial.selectedChannels.length > 0
          ? partial.selectedChannels
          : state.selectedChannels,
    })),
  reset: () =>
    set({
      step: 1,
      businessName: '',
      teamSize: 5,
      businessType: '',
      selectedChannels: ['whatsapp', 'email'],
    }),
}));
