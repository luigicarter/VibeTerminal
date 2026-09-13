import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type RootStackParamList = {
  Find: undefined;
  Approve: {
    host: string;
    port: number;
    desktopId: string;
    desktopHost: string;
    version: string;
    readOnly: boolean;
  };
  ManualPair: undefined;
  Projects: undefined;
  Project: { projectId: string };
  Chat: { sessionId: string };
  Lina: undefined;
  Settings: undefined;
};

export type RootScreenProps<Name extends keyof RootStackParamList> = NativeStackScreenProps<
  RootStackParamList,
  Name
>;
