import { supabase } from './supabase';

/** Resolves once with the current session (null if unauthenticated). */
export async function getCurrentSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function signInWithPassword(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/** Registers a listener for auth state changes; returns an unsubscribe function. */
export function onAuthStateChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
  return () => data.subscription.unsubscribe();
}

/**
 * Reads the authorization role for a user from public.profiles.
 * Role is never derived from the email address or any client-supplied value —
 * it always comes from this server-side row, which RLS restricts to the
 * caller's own profile (see docs/SUPABASE_MIGRATION.md).
 */
export async function fetchProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, role')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}
