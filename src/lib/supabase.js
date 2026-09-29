import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase configuration: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local ' +
      '(see .env.example). The anon key only, never service_role.'
  );
}

// Anon key is safe in client code only because RLS is enabled on every table
// (see docs/SUPABASE_MIGRATION.md). Never import a service_role key here.
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
