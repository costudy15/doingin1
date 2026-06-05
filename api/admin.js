// /api/admin  — 관리자/로그인/문제저장 서버리스 (service_role 키, RLS 우회)
// body: { action, payload, adminCode }
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ADMIN_CODE = process.env.ADMIN_CODE || ''
const BUCKET = 'problem-images'

function db() { return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } }) }

// data URL -> Storage 업로드 후 공개 URL 반환. 이미 http(s) URL이면 그대로 반환.
async function uploadIfDataUrl(supabase, path, maybeDataUrl) {
  if (!maybeDataUrl) return null
  if (!String(maybeDataUrl).startsWith('data:')) return maybeDataUrl
  const m = String(maybeDataUrl).match(/^data:([^;]+);base64,(.*)$/)
  if (!m) return null
  const contentType = m[1]
  const bytes = Buffer.from(m[2], 'base64')
  const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true })
  if (error) throw new Error('업로드 실패: ' + error.message)
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return data.publicUrl
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return }
  if (!SUPABASE_URL || !SERVICE_KEY) { res.status(500).json({ ok: false, error: 'Supabase 서버 환경변수 미설정' }); return }

  const { action, payload = {}, adminCode } = req.body || {}
  const supabase = db()
  const requireAdmin = () => {
    if (!ADMIN_CODE || adminCode !== ADMIN_CODE) { const e = new Error('관리자 인증 실패'); e.code = 401; throw e }
  }

  try {
    switch (action) {
      case 'login': {
        // 관리자
        if (payload.code != null) {
          if (ADMIN_CODE && payload.code === ADMIN_CODE) {
            res.status(200).json({ ok: true, user: { role: 'admin', name: '선생님', adminCode: ADMIN_CODE } }); return
          }
          res.status(200).json({ ok: false, error: '관리자 코드가 올바르지 않습니다.' }); return
        }
        // 학생: 이름 + pw(휴대폰 뒤 4자리)
        const name = (payload.name || '').trim()
        const pw = (payload.pw || '').trim()
        const { data, error } = await supabase.from('students').select('name, school, grade, pw').eq('name', name).maybeSingle()
        if (error) throw error
        if (!data || String(data.pw) !== pw) { res.status(200).json({ ok: false, error: '이름 또는 번호가 올바르지 않습니다.' }); return }
        res.status(200).json({ ok: true, user: { role: 'student', name: data.name, school: data.school, grade: data.grade } })
        return
      }

      case 'listStudents': {
        requireAdmin()
        const { data, error } = await supabase.from('students').select('name, school, grade, pw').order('name')
        if (error) throw error
        res.status(200).json({ ok: true, students: data || [] }); return
      }

      case 'addStudent': {
        requireAdmin()
        const row = {
          name: (payload.name || '').trim(),
          school: (payload.school || '').trim(),
          grade: (payload.grade || '').trim(),
          pw: (payload.pw || '').trim()
        }
        if (!row.name || !row.pw) { res.status(200).json({ ok: false, error: '이름과 뒤 4자리는 필수입니다.' }); return }
        const { error } = await supabase.from('students').upsert(row, { onConflict: 'name' })
        if (error) throw error
        res.status(200).json({ ok: true }); return
      }

      case 'deleteStudent': {
        requireAdmin()
        const { error } = await supabase.from('students').delete().eq('name', (payload.name || '').trim())
        if (error) throw error
        res.status(200).json({ ok: true }); return
      }

      case 'saveProblem': {
        requireAdmin()
        const worksheet = payload.worksheet
        const id = parseInt(payload.id, 10)
        if (!worksheet || !id) { res.status(200).json({ ok: false, error: 'worksheet/id 누락' }); return }

        const problemImg = await uploadIfDataUrl(supabase, `problems/${worksheet}-${id}-problem.jpg`, payload.problemImg)

        const solutions = []
        for (const s of (payload.solutions || [])) {
          if (!s || !s.img) continue
          const rand = Math.random().toString(36).slice(2, 7)
          const url = await uploadIfDataUrl(supabase, `problems/${worksheet}-${id}-sol-${Date.now()}-${rand}.jpg`, s.img)
          if (url) solutions.push({ img: url, label: (s.label || '').trim() })
        }

        const row = {
          worksheet, id,
          problem_img: problemImg,
          solution_img: solutions[0]?.img || null,
          solutions,
          points: payload.points || '',
          video_url: payload.videoUrl || '',
          updated_at: new Date().toISOString()
        }
        const { error } = await supabase.from('problems').upsert(row, { onConflict: 'worksheet,id' })
        if (error) throw error
        res.status(200).json({ ok: true, problemImg, solutions }); return
      }

      case 'setCount': {
        requireAdmin()
        const { error } = await supabase.from('worksheets').update({ count: parseInt(payload.count, 10) || 0 }).eq('id', payload.worksheet)
        if (error) throw error
        res.status(200).json({ ok: true }); return
      }

      case 'addWorksheet': {
        requireAdmin()
        const name = (payload.name || '').trim()
        const count = parseInt(payload.count, 10) || 0
        if (!name) { res.status(200).json({ ok: false, error: '학습지 이름이 필요합니다.' }); return }
        const { data: maxRow } = await supabase.from('worksheets').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle()
        const sort_order = (maxRow?.sort_order || 0) + 1
        const wsId = 'ws_' + Date.now().toString(36)
        const { error } = await supabase.from('worksheets').insert({ id: wsId, name, count, sort_order })
        if (error) throw error
        res.status(200).json({ ok: true, id: wsId }); return
      }

      case 'listLog': {
        requireAdmin()
        const { data, error } = await supabase.from('question_log').select('id, student, problem, worksheet, question, created_at').order('created_at', { ascending: false }).limit(1000)
        if (error) throw error
        res.status(200).json({ ok: true, log: data || [] }); return
      }

      default:
        res.status(400).json({ ok: false, error: '알 수 없는 action: ' + action }); return
    }
  } catch (e) {
    const code = e.code === 401 ? 401 : 500
    res.status(code).json({ ok: false, error: String(e?.message || e) })
  }
}
