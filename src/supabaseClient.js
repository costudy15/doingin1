import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL || 'https://YOUR-PROJECT.supabase.co'
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY || 'YOUR-ANON-KEY'

export const supabase = createClient(url, anon)
