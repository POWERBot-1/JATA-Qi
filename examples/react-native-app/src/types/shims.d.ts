// Ambient type shims for the zero-dependency typecheck config
// (`npm run typecheck` → tsconfig.typecheck.json).
//
// The sandbox CI has no Expo/React Native toolchain, so this file lets the
// reference app's TSX compile and type-check against the real @jataqi/sdk and
// @jataqi/mobile-app sources without installing react-native. When you develop
// for real (`npm install` in this folder), use tsconfig.json (expo/tsconfig.base)
// and the shims are excluded.

declare module 'react' {
  export type ReactNode = unknown;
  export type ReactElement = unknown;
  export type ReactPortal = unknown;
  export function useState<T>(initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useRef<T>(initial: T): { current: T };
  export function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
  export function useMemo<T>(fn: () => T, deps: readonly unknown[]): T;
  export function createContext<T>(defaultValue: T): { Provider: unknown; Consumer: unknown };
  export function useContext<T>(ctx: { Provider: unknown; Consumer: unknown }): T;
  export const Fragment: unknown;
  export namespace JSX {
    interface Element {}
    interface ElementClass {}
    interface IntrinsicElements {
      [elem: string]: any;
    }
  }
}

declare module 'react/jsx-runtime' {
  export function jsx(type: unknown, props: Record<string, unknown>): unknown;
  export function jsxs(type: unknown, props: Record<string, unknown>): unknown;
  export const Fragment: unknown;
}

declare module 'react-native' {
  export const View: any;
  export const Text: any;
  export const TextInput: any;
  export const Pressable: any;
  export const ScrollView: any;
  export const FlatList: any;
  export const RefreshControl: any;
  export const ActivityIndicator: any;
  export const Alert: any;
  export const Platform: { OS: string; select<T>(spec: Record<string, T>): T };
  export const KeyboardAvoidingView: any;
  export const StyleSheet: { create<T extends Record<string, unknown>>(styles: T): T };
  export type View = any;
  export type Text = any;
  export type TextInput = any;
  export type Pressable = any;
  export type ScrollView = any;
  export type FlatList = any;
  export type RefreshControl = any;
  export type ActivityIndicator = any;
  export type Alert = any;
  export type KeyboardAvoidingView = any;
}

declare module 'expo-status-bar' {
  export const StatusBar: any;
}

declare module '@react-native-async-storage/async-storage' {
  export const AsyncStorage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  };
  export default AsyncStorage;
}
