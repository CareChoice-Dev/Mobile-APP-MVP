import 'react-native-url-polyfill/auto';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { createClient, type SupportedStorage } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase config. Copy .env.example to .env and set ' +
      'EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.',
  );
}

/**
 * Session storage adapter.
 *
 * On native we persist the auth session in the OS keystore via expo-secure-store
 * (encrypted at rest). SecureStore values are capped at ~2KB; Supabase sessions
 * fit comfortably. On web there is no SecureStore, so we fall back to
 * AsyncStorage (localStorage-backed).
 */
const SecureStoreAdapter: SupportedStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};

const storage: SupportedStorage =
  Platform.OS === 'web' ? AsyncStorage : SecureStoreAdapter;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage,
    autoRefreshToken: true,
    persistSession: true,
    // No URL-based session detection on native; relevant only to web OAuth.
    detectSessionInUrl: Platform.OS === 'web',
  },
});
