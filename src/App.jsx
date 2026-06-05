/*
   동인고 학습지 풀이 앱 · Costudy (배포 버전)
   - 거의 모든 프론트엔드 코드가 이 한 파일에 있음 (CSS는 하단 StyleBlock).
   - 공개 읽기(worksheets/problems)와 학생 개인데이터(student_problem)는 anon 클라이언트로 직접.
   - 관리자 작업/학생 로그인/문제 저장은 /api/admin (service_role) 경유.
*/
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from './supabaseClient'

const BRAND = '동인고 학습지 풀이 앱'

/* ============================================================
   헬퍼
============================================================ */
async function callAdmin(action, payload, adminCode) {
  const r = await fetch('/api/admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, payload, adminCode })
  })
  return r.json()
}

async function askTutor(problem, history, question, region) {
  const r = await fetch('/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ problem, history, question, region })
  })
  return r.json()
}

// DB row -> 화면용 problem (레거시 단일 손풀이 호환)
function rowToProblem(r) {
  if (!r) return null
  let solutions = Array.isArray(r.solutions) ? r.solutions : []
  if ((!solutions || solutions.length === 0) && r.solution_img) {
    solutions = [{ img: r.solution_img, label: '' }]
  }
  return {
    id: r.id,
    worksheet: r.worksheet,
    problemImg: r.problem_img || '',
    solutionImg: solutions[0]?.img || r.solution_img || '',
    solutions,
    points: r.points || '',
    videoUrl: r.video_url || ''
  }
}

// 업로드 전 이미지 압축 (최대 1200px JPEG)
function compressImage(file, maxDim = 1200, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        let { width, height } = img
        if (width > maxDim || height > maxDim) {
          if (width >= height) { height = Math.round(height * maxDim / width); width = maxDim }
          else { width = Math.round(width * maxDim / height); height = maxDim }
        }
        const canvas = document.createElement('canvas')
        canvas.width = width; canvas.height = height
        canvas.getContext('2d').drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.onerror = reject
      img.src = reader.result
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// 손풀이에서 드래그한 영역 → 하이라이트 이미지 + 확대 이미지
function makeRegionImages(url, sel) {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const W = img.naturalWidth, H = img.naturalHeight
        const x = Math.max(0, Math.round(sel.x * W))
        const y = Math.max(0, Math.round(sel.y * H))
        const w = Math.min(W - x, Math.round(sel.w * W))
        const h = Math.min(H - y, Math.round(sel.h * H))
        // 하이라이트(전체 + 어둡게 + 선택영역만 밝게/테두리)
        const c1 = document.createElement('canvas'); c1.width = W; c1.height = H
        const g1 = c1.getContext('2d')
        g1.drawImage(img, 0, 0)
        g1.fillStyle = 'rgba(0,0,0,0.45)'; g1.fillRect(0, 0, W, H)
        g1.clearRect(x, y, w, h); g1.drawImage(img, x, y, w, h, x, y, w, h)
        g1.strokeStyle = '#d9a13a'; g1.lineWidth = Math.max(3, Math.round(W / 250)); g1.strokeRect(x, y, w, h)
        const highlight = c1.toDataURL('image/jpeg', 0.85)
        // 확대(선택영역만 크롭, 가로 720 기준)
        const scale = Math.min(3, Math.max(1, 720 / Math.max(1, w)))
        const c2 = document.createElement('canvas'); c2.width = Math.round(w * scale); c2.height = Math.round(h * scale)
        c2.getContext('2d').drawImage(img, x, y, w, h, 0, 0, c2.width, c2.height)
        const zoom = c2.toDataURL('image/jpeg', 0.85)
        resolve({ highlight, zoom })
      } catch (e) {
        resolve({ coords: `좌(${Math.round(sel.x * 100)}%, ${Math.round(sel.y * 100)}%)~크기(${Math.round(sel.w * 100)}%×${Math.round(sel.h * 100)}%)` })
      }
    }
    img.onerror = () => resolve({ coords: `좌(${Math.round(sel.x * 100)}%, ${Math.round(sel.y * 100)}%)` })
    img.src = url
  })
}

function toast(msg) {
  const el = document.createElement('div')
  el.className = 'cs-toast'; el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => { el.classList.add('show') }, 10)
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300) }, 1800)
}

/* ============================================================
   App (루트)
============================================================ */
export default function App() {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('cs_user') || 'null') } catch { return null }
  })
  const [worksheets, setWorksheets] = useState([])
  const [currentWs, setCurrentWs] = useState(null)
  const [problems, setProblems] = useState({})       // id -> problem (현재 학습지)
  const [problemCount, setProblemCount] = useState(0)
  const [students, setStudents] = useState([])
  const [qlog, setQlog] = useState([])
  const [view, setView] = useState('home')            // home | problem
  const [activeWs, setActiveWs] = useState(null)
  const [activeProb, setActiveProb] = useState(null)
  const [booting, setBooting] = useState(true)

  const loadWorksheets = useCallback(async () => {
    const { data } = await supabase.from('worksheets').select('*').order('sort_order')
    const list = data || []
    setWorksheets(list)
    setCurrentWs(prev => prev || (list[0]?.id || null))
    return list
  }, [])

  const loadProblems = useCallback(async (wsId) => {
    if (!wsId) { setProblems({}); setProblemCount(0); return }
    const ws = worksheets.find(w => w.id === wsId)
    const { data } = await supabase.from('problems').select('*').eq('worksheet', wsId)
    const map = {}
    for (const r of (data || [])) map[r.id] = rowToProblem(r)
    setProblems(map)
    setProblemCount(ws?.count || 0)
  }, [worksheets])

  const loadAdmin = useCallback(async (adminCode) => {
    const s = await callAdmin('listStudents', {}, adminCode)
    if (s.ok) setStudents(s.students)
    const l = await callAdmin('listLog', {}, adminCode)
    if (l.ok) setQlog(l.log)
  }, [])

  useEffect(() => { loadWorksheets().finally(() => setBooting(false)) }, [loadWorksheets])
  useEffect(() => { if (currentWs) loadProblems(currentWs) }, [currentWs, loadProblems])
  useEffect(() => { if (user?.role === 'admin' && user.adminCode) loadAdmin(user.adminCode) }, [user, loadAdmin])

  function onLogin(u) {
    setUser(u)
    localStorage.setItem('cs_user', JSON.stringify(u))
  }
  function logout() {
    setUser(null); setView('home'); setActiveWs(null); setActiveProb(null)
    localStorage.removeItem('cs_user')
  }

  function selectWorksheet(wsId) { setCurrentWs(wsId) }

  async function openProblem(wsId, id) {
    if (wsId !== currentWs) { setCurrentWs(wsId); await loadProblems(wsId) }
    setActiveWs(wsId); setActiveProb(id); setView('problem')
  }
  function closeProblem() { setView('home'); setActiveProb(null) }

  async function saveProblem(p) {
    const payload = {
      worksheet: currentWs, id: p.id,
      problemImg: p.problemImg, solutions: p.solutions,
      points: p.points, videoUrl: p.videoUrl
    }
    const res = await callAdmin('saveProblem', payload, user.adminCode)
    if (!res.ok) { toast('저장 실패: ' + (res.error || '')); return false }
    await loadProblems(currentWs)
    toast('저장됨')
    return true
  }

  async function addProblems(n) {
    const ws = worksheets.find(w => w.id === currentWs)
    const next = (ws?.count || 0) + n
    const res = await callAdmin('setCount', { worksheet: currentWs, count: next }, user.adminCode)
    if (res.ok) { await loadWorksheets(); setProblemCount(next) }
  }

  async function addWorksheet(name, count) {
    const res = await callAdmin('addWorksheet', { name, count }, user.adminCode)
    if (res.ok) { const list = await loadWorksheets(); setCurrentWs(res.id) }
    else toast('추가 실패: ' + (res.error || ''))
  }

  async function addStudent(s) {
    const res = await callAdmin('addStudent', s, user.adminCode)
    if (res.ok) loadAdmin(user.adminCode); else toast('실패: ' + (res.error || ''))
  }
  async function deleteStudent(name) {
    const res = await callAdmin('deleteStudent', { name }, user.adminCode)
    if (res.ok) loadAdmin(user.adminCode)
  }

  async function logQuestion(problemId, question) {
    try {
      await supabase.from('question_log').insert({ student: user?.name || '', problem: problemId, worksheet: activeWs || currentWs, question })
    } catch {}
  }

  if (booting) return (<><StyleBlock /><div className="cs-center"><div className="cs-spinner" /></div></>)

  if (!user) return (<><StyleBlock /><Login onLogin={onLogin} /></>)

  return (
    <>
      <StyleBlock />
      {user.role === 'admin' ? (
        <AdminApp
          user={user} worksheets={worksheets} currentWs={currentWs} problems={problems}
          problemCount={problemCount} students={students} qlog={qlog}
          onSelectWs={selectWorksheet} onSaveProblem={saveProblem} onAddProblems={addProblems}
          onAddWorksheet={addWorksheet} onAddStudent={addStudent} onDeleteStudent={deleteStudent}
          onLogout={logout}
        />
      ) : view === 'problem' ? (
        <ProblemView
          user={user} wsId={activeWs} problemId={activeProb}
          worksheets={worksheets} onBack={closeProblem} onLogQuestion={logQuestion} onLogout={logout}
        />
      ) : (
        <StudentHome
          user={user} worksheets={worksheets} currentWs={currentWs} problems={problems}
          problemCount={problemCount} onSelectWs={selectWorksheet} onOpen={openProblem} onLogout={logout}
        />
      )}
    </>
  )
}

/* ============================================================
   Header
============================================================ */
function Header({ title, sub, onBack, onLogout }) {
  return (
    <header className="cs-header">
      <div className="cs-header-l">
        {onBack && <button className="cs-back" onClick={onBack}>←</button>}
        <img className="cs-header-logo" src="/costudy-mark.png" alt="코스터디" />
        <div>
          <div className="cs-header-title">{title}</div>
          {sub && <div className="cs-header-sub">{sub}</div>}
        </div>
      </div>
      {onLogout && <button className="cs-logout" onClick={onLogout}>로그아웃</button>}
    </header>
  )
}

/* ============================================================
   Login
============================================================ */
function Login({ onLogin }) {
  const [mode, setMode] = useState('student')
  const [name, setName] = useState('')
  const [pw, setPw] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit() {
    setErr(''); setBusy(true)
    try {
      const payload = mode === 'student' ? { name: name.trim(), pw: pw.trim() } : { code: code.trim() }
      const res = await callAdmin('login', payload)
      if (res.ok) onLogin(res.user)
      else setErr(res.error || '로그인 실패')
    } catch (e) { setErr('네트워크 오류') }
    setBusy(false)
  }

  return (
    <div className="cs-login-wrap">
      <div className="cs-login-card">
        <div className="cs-brand">
          <img className="cs-brand-badge" src="/costudy-mark.png" alt="코스터디학원" />
          <div className="cs-brand-text">
            <div className="cs-brand-title">{BRAND}</div>
            <div className="cs-brand-sub">코스터디학원</div>
          </div>
        </div>

        {mode === 'student' ? (
          <>
            <label className="cs-flabel">이름</label>
            <input className="cs-finput" placeholder="예: 박서연" value={name}
              onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
            <label className="cs-flabel">비밀번호 (휴대폰 뒤 4자리)</label>
            <input className="cs-finput" type="password" inputMode="numeric" maxLength={4} placeholder="••••" value={pw}
              onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
          </>
        ) : (
          <>
            <label className="cs-flabel">관리자 코드</label>
            <input className="cs-finput" type="password" placeholder="관리자 코드" value={code}
              onChange={e => setCode(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
          </>
        )}

        {err && <div className="cs-err">{err}</div>}

        <button className="cs-loginbtn" disabled={busy} onClick={submit}>{busy ? '확인 중…' : '로그인'}</button>

        <button className="cs-modelink" onClick={() => { setErr(''); setMode(m => m === 'student' ? 'admin' : 'student') }}>
          {mode === 'student' ? '선생님(관리자)으로 들어가기' : '← 학생으로 돌아가기'}
        </button>
      </div>
    </div>
  )
}

/* ============================================================
   StudentHome — [전체 문제] / [⭐ 내 오답노트]
============================================================ */
function StudentHome({ user, worksheets, currentWs, problems, problemCount, onSelectWs, onOpen, onLogout }) {
  const [tab, setTab] = useState('all')
  const [saved, setSaved] = useState([])
  const [loadingSaved, setLoadingSaved] = useState(false)

  const loadSaved = useCallback(async () => {
    setLoadingSaved(true)
    const { data } = await supabase.from('student_problem')
      .select('worksheet, problem, note').eq('student', user.name).eq('saved', true)
    setSaved(data || [])
    setLoadingSaved(false)
  }, [user.name])

  useEffect(() => { if (tab === 'saved') loadSaved() }, [tab, loadSaved])

  const wsName = (id) => worksheets.find(w => w.id === id)?.name || id

  async function removeSaved(ws, problem) {
    if (!confirm('오답노트에서 뺄까요? (메모·대화기록은 남아요)')) return
    await supabase.from('student_problem')
      .upsert({ student: user.name, worksheet: ws, problem, saved: false, updated_at: new Date().toISOString() },
        { onConflict: 'student,worksheet,problem' })
    loadSaved()
  }

  return (
    <div className="cs-page">
      <Header title={`${user.name} 님`} sub={BRAND} onLogout={onLogout} />

      <div className="cs-tabs">
        <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>전체 문제</button>
        <button className={tab === 'saved' ? 'on' : ''} onClick={() => setTab('saved')}>⭐ 내 오답노트</button>
      </div>

      {tab === 'all' ? (
        <>
          <div className="cs-pills">
            {worksheets.map(w => (
              <button key={w.id} className={w.id === currentWs ? 'on' : ''} onClick={() => onSelectWs(w.id)}>
                {w.name} <span className="cs-pill-cnt">{w.count}</span>
              </button>
            ))}
          </div>
          <div className="cs-grid">
            {Array.from({ length: problemCount }, (_, i) => i + 1).map(n => {
              const has = problems[n] && problems[n].problemImg
              return (
                <button key={n} className={`cs-cell ${has ? 'ready' : 'empty'}`} onClick={() => onOpen(currentWs, n)}>
                  {n}
                </button>
              )
            })}
            {problemCount === 0 && <div className="cs-muted">아직 등록된 문제가 없어요.</div>}
          </div>
        </>
      ) : (
        <div className="cs-saved">
          {loadingSaved ? <div className="cs-muted">불러오는 중…</div> :
            saved.length === 0 ? <div className="cs-muted">⭐로 저장한 문제가 여기 모여요.</div> :
              saved.map((s, i) => (
                <div key={i} className="cs-saved-item">
                  <button className="cs-saved-open" onClick={() => onOpen(s.worksheet, s.problem)}>
                    <span className="cs-tag">{wsName(s.worksheet)}</span>
                    <b>{s.problem}번</b>
                    {s.note ? <span className="cs-saved-note">💡 {s.note.slice(0, 40)}</span> : null}
                  </button>
                  <button className="cs-saved-del" onClick={() => removeSaved(s.worksheet, s.problem)}>삭제</button>
                </div>
              ))}
        </div>
      )}
      <div className="cs-foot">코스터디학원 제공 · Co-Study Academy</div>
    </div>
  )
}

/* ============================================================
   ProblemView — 문제 + 손풀이(여러 개 탭) + 메모 + AI 채팅 + 영역선택
============================================================ */
function ProblemView({ user, wsId, problemId, worksheets, onBack, onLogQuestion, onLogout }) {
  const [prob, setProb] = useState(null)
  const [solIdx, setSolIdx] = useState(0)
  const [loading, setLoading] = useState(true)

  const [saved, setSaved] = useState(false)
  const [note, setNote] = useState('')
  const [chat, setChat] = useState([])           // [{role,text}]
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)

  // 영역선택
  const [selecting, setSelecting] = useState(false)
  const [sel, setSel] = useState(null)            // {x,y,w,h} (0~1)
  const [region, setRegion] = useState(null)      // 전송용
  const imgWrapRef = useRef(null)
  const dragRef = useRef(null)
  const noteTimer = useRef(null)
  const chatEndRef = useRef(null)

  const wsName = worksheets.find(w => w.id === wsId)?.name || wsId

  // 문제 자체 fetch (학습지 간 이동 안전)
  useEffect(() => {
    let live = true
    setLoading(true)
    ;(async () => {
      const { data } = await supabase.from('problems').select('*').eq('worksheet', wsId).eq('id', problemId).maybeSingle()
      if (live) { setProb(rowToProblem(data) || { id: problemId, worksheet: wsId, problemImg: '', solutions: [], points: '', videoUrl: '' }); setSolIdx(0); setLoading(false) }
    })()
    return () => { live = false }
  }, [wsId, problemId])

  // 개인 데이터 fetch
  useEffect(() => {
    let live = true
    ;(async () => {
      const { data } = await supabase.from('student_problem').select('saved, note, chat')
        .eq('student', user.name).eq('worksheet', wsId).eq('problem', problemId).maybeSingle()
      if (live && data) { setSaved(!!data.saved); setNote(data.note || ''); setChat(Array.isArray(data.chat) ? data.chat : []) }
      else if (live) { setSaved(false); setNote(''); setChat([]) }
    })()
    return () => { live = false }
  }, [user.name, wsId, problemId])

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [chat, asking])

  async function persist(partial) {
    await supabase.from('student_problem').upsert(
      { student: user.name, worksheet: wsId, problem: problemId, ...partial, updated_at: new Date().toISOString() },
      { onConflict: 'student,worksheet,problem' }
    )
  }

  async function toggleSaved() {
    const next = !saved; setSaved(next)
    await persist({ saved: next })
    toast(next ? '오답노트에 저장했어요' : '오답노트에서 뺐어요')
  }

  function onNoteChange(v) {
    setNote(v)
    clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => persist({ note: v }), 700)
  }

  const solutions = prob?.solutions?.length ? prob.solutions : (prob?.solutionImg ? [{ img: prob.solutionImg, label: '' }] : [])
  const currentSolImg = solutions[solIdx]?.img || ''

  // 드래그 영역 선택
  function pointFromEvent(e) {
    const box = imgWrapRef.current.getBoundingClientRect()
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - box.left
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - box.top
    return { x: Math.min(1, Math.max(0, cx / box.width)), y: Math.min(1, Math.max(0, cy / box.height)) }
  }
  function startDrag(e) {
    if (!selecting) return
    e.preventDefault()
    const p = pointFromEvent(e); dragRef.current = p; setSel({ x: p.x, y: p.y, w: 0, h: 0 })
  }
  function moveDrag(e) {
    if (!selecting || !dragRef.current) return
    const p = pointFromEvent(e); const s = dragRef.current
    setSel({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) })
  }
  async function endDrag() {
    if (!selecting || !dragRef.current) return
    dragRef.current = null
    if (sel && sel.w > 0.02 && sel.h > 0.02 && currentSolImg) {
      const r = await makeRegionImages(currentSolImg, sel)
      setRegion(r); toast('표시한 부분을 질문에 첨부했어요')
    }
    setSelecting(false)
  }
  function clearRegion() { setRegion(null); setSel(null) }

  async function send() {
    const q = question.trim()
    if (!q || asking) return
    const newChat = [...chat, { role: 'user', text: q }]
    setChat(newChat); setQuestion(''); setAsking(true)
    onLogQuestion(problemId, q)
    const history = chat   // 직전까지의 기록
    const res = await askTutor(
      { id: prob.id, problemImg: prob.problemImg, solutionImg: currentSolImg, points: prob.points },
      history, q, region
    )
    const answer = res.ok ? res.answer : ('죄송해요, 답변 생성에 실패했어요. (' + (res.error || '') + ')')
    const finalChat = [...newChat, { role: 'assistant', text: answer }]
    setChat(finalChat)
    setAsking(false)
    clearRegion()
    persist({ chat: finalChat })
  }

  if (loading) return (<div className="cs-page"><Header title={`${problemId}번`} sub={wsName} onBack={onBack} onLogout={onLogout} /><div className="cs-center"><div className="cs-spinner" /></div></div>)

  return (
    <div className="cs-page">
      <Header title={`${problemId}번 문제`} sub={wsName} onBack={onBack} onLogout={onLogout} />

      <div className="cs-prob-actions">
        <button className={`cs-star ${saved ? 'on' : ''}`} onClick={toggleSaved}>{saved ? '⭐ 저장됨' : '☆ 오답노트'}</button>
        {prob.videoUrl ? <a className="cs-video" href={prob.videoUrl} target="_blank" rel="noreferrer">▶ 강의영상</a> : null}
      </div>

      {prob.problemImg
        ? <div className="cs-imgcard"><div className="cs-imgcard-label">문제</div><img src={prob.problemImg} alt="문제" /></div>
        : <div className="cs-imgcard cs-imgcard-empty">문제 이미지가 아직 등록되지 않았어요.</div>}

      {solutions.length > 0 && (
        <div className="cs-imgcard">
          <div className="cs-imgcard-label">
            손풀이
            <button className={`cs-region-toggle ${selecting ? 'on' : ''}`} onClick={() => { setSelecting(s => !s); setSel(null) }}>
              {selecting ? '취소' : '🔲 부분 선택'}
            </button>
          </div>
          {solutions.length > 1 && (
            <div className="cs-soltabs">
              {solutions.map((s, i) => (
                <button key={i} className={i === solIdx ? 'on' : ''} onClick={() => setSolIdx(i)}>
                  {s.label || `풀이 ${i + 1}`}
                </button>
              ))}
            </div>
          )}
          <div
            ref={imgWrapRef}
            className={`cs-solwrap ${selecting ? 'selecting' : ''}`}
            onMouseDown={startDrag} onMouseMove={moveDrag} onMouseUp={endDrag} onMouseLeave={endDrag}
            onTouchStart={startDrag} onTouchMove={moveDrag} onTouchEnd={endDrag}
          >
            <img src={currentSolImg} alt="손풀이" draggable={false} />
            {sel && (sel.w > 0 || sel.h > 0) && (
              <div className="cs-selbox" style={{ left: `${sel.x * 100}%`, top: `${sel.y * 100}%`, width: `${sel.w * 100}%`, height: `${sel.h * 100}%` }} />
            )}
          </div>
        </div>
      )}

      {/* 내 메모 */}
      <div className="cs-note">
        <div className="cs-note-label">💡 내 메모</div>
        <textarea className="cs-textarea" placeholder="이 문제에서 깨달은 점을 적어두세요 (자동 저장)"
          value={note} onChange={e => onNoteChange(e.target.value)} rows={3} />
      </div>

      {/* AI 채팅 */}
      <div className="cs-chat">
        <div className="cs-chat-label">💬 AI 선생님에게 질문</div>
        <div className="cs-chat-log">
          {chat.length === 0 && <div className="cs-muted">궁금한 부분을 물어보세요. 손풀이에서 막힌 곳을 🔲로 골라 함께 물어볼 수도 있어요.</div>}
          {chat.map((m, i) => (
            <div key={i} className={`cs-bubble ${m.role}`}>{m.text}</div>
          ))}
          {asking && <div className="cs-bubble assistant cs-typing">답변 작성 중…</div>}
          <div ref={chatEndRef} />
        </div>
        {region && (
          <div className="cs-region-chip">📎 표시한 부분 첨부됨 <button onClick={clearRegion}>✕</button></div>
        )}
        <div className="cs-chat-input">
          <textarea className="cs-textarea" placeholder="질문을 입력하세요" value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} rows={1} />
          <button className="cs-send" disabled={asking || !question.trim()} onClick={send}>보내기</button>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   AdminApp — 문제관리 / 학생관리 / 질문로그
============================================================ */
function AdminApp(props) {
  const { user, onLogout } = props
  const [tab, setTab] = useState('manage')
  return (
    <div className="cs-page">
      <Header title="선생님 관리자" sub={BRAND} onLogout={onLogout} />
      <div className="cs-tabs">
        <button className={tab === 'manage' ? 'on' : ''} onClick={() => setTab('manage')}>문제 관리</button>
        <button className={tab === 'students' ? 'on' : ''} onClick={() => setTab('students')}>학생 관리</button>
        <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>질문 로그</button>
      </div>
      {tab === 'manage' && <AdminManage {...props} />}
      {tab === 'students' && <AdminStudents students={props.students} onAdd={props.onAddStudent} onDelete={props.onDeleteStudent} />}
      {tab === 'log' && <AdminLog qlog={props.qlog} worksheets={props.worksheets} />}
    </div>
  )
}

function AdminManage({ worksheets, currentWs, problems, problemCount, onSelectWs, onSaveProblem, onAddProblems, onAddWorksheet }) {
  const [editing, setEditing] = useState(null)   // problemId
  const [showAddWs, setShowAddWs] = useState(false)
  const [wsName, setWsName] = useState('')
  const [wsCount, setWsCount] = useState(13)

  function cellClass(n) {
    const p = problems[n]
    if (!p || !p.problemImg) return 'empty'
    const hasSol = (p.solutions && p.solutions.length > 0)
    return hasSol ? 'ready' : 'partial'
  }

  if (editing != null) {
    return <ProblemEditor
      id={editing} initial={problems[editing]}
      onCancel={() => setEditing(null)}
      onSave={async (p) => { const ok = await onSaveProblem(p); if (ok) setEditing(null) }}
    />
  }

  return (
    <div className="cs-admin">
      <div className="cs-pills">
        {worksheets.map(w => (
          <button key={w.id} className={w.id === currentWs ? 'on' : ''} onClick={() => onSelectWs(w.id)}>
            {w.name} <span className="cs-pill-cnt">{w.count}</span>
          </button>
        ))}
        <button className="cs-pill-add" onClick={() => setShowAddWs(s => !s)}>+ 새 학습지</button>
      </div>

      {showAddWs && (
        <div className="cs-addws">
          <input className="cs-input" placeholder="학습지 이름 (예: 함수)" value={wsName} onChange={e => setWsName(e.target.value)} />
          <input className="cs-input cs-input-sm" type="number" placeholder="문항수" value={wsCount} onChange={e => setWsCount(e.target.value)} />
          <button className="cs-btn cs-btn-primary" onClick={() => { if (wsName.trim()) { onAddWorksheet(wsName.trim(), parseInt(wsCount, 10) || 0); setWsName(''); setShowAddWs(false) } }}>추가</button>
        </div>
      )}

      <div className="cs-legend">
        <span><i className="dot ready" /> 완료</span>
        <span><i className="dot partial" /> 문제만</span>
        <span><i className="dot empty" /> 미등록</span>
      </div>

      <div className="cs-grid">
        {Array.from({ length: problemCount }, (_, i) => i + 1).map(n => (
          <button key={n} className={`cs-cell ${cellClass(n)}`} onClick={() => setEditing(n)}>{n}</button>
        ))}
      </div>

      <div className="cs-add-row">
        <button className="cs-btn" onClick={() => onAddProblems(1)}>+ 문제 1개</button>
        <button className="cs-btn" onClick={() => onAddProblems(5)}>+ 5개</button>
      </div>
    </div>
  )
}

function ProblemEditor({ id, initial, onCancel, onSave }) {
  const [problemImg, setProblemImg] = useState(initial?.problemImg || '')
  const [solutions, setSolutions] = useState(initial?.solutions?.length ? initial.solutions : [])
  const [points, setPoints] = useState(initial?.points || '')
  const [videoUrl, setVideoUrl] = useState(initial?.videoUrl || '')
  const [busy, setBusy] = useState(false)

  async function pickProblem(e) {
    const f = e.target.files?.[0]; if (!f) return
    setProblemImg(await compressImage(f))
  }
  async function addSolution(e) {
    const f = e.target.files?.[0]; if (!f) return
    const img = await compressImage(f)
    setSolutions(s => [...s, { img, label: '' }])
    e.target.value = ''
  }
  function setLabel(i, v) { setSolutions(s => s.map((x, idx) => idx === i ? { ...x, label: v } : x)) }
  function removeSolution(i) { setSolutions(s => s.filter((_, idx) => idx !== i)) }

  async function save() {
    setBusy(true)
    await onSave({ id, problemImg, solutions, points, videoUrl })
    setBusy(false)
  }

  return (
    <div className="cs-editor">
      <div className="cs-editor-head">
        <button className="cs-back" onClick={onCancel}>←</button>
        <b>{id}번 문제 편집</b>
      </div>

      <div className="cs-field">
        <label>문제 이미지</label>
        {problemImg && <img className="cs-thumb" src={problemImg} alt="문제" />}
        <input type="file" accept="image/*" onChange={pickProblem} />
      </div>

      <div className="cs-field">
        <label>손풀이 (여러 개 가능 · 선생님별 라벨)</label>
        {solutions.map((s, i) => (
          <div key={i} className="cs-sol-edit">
            <img className="cs-thumb-sm" src={s.img} alt={`풀이${i + 1}`} />
            <input className="cs-input cs-input-sm" placeholder="라벨 (예: 김선생님 풀이)" value={s.label} onChange={e => setLabel(i, e.target.value)} />
            <button className="cs-x" onClick={() => removeSolution(i)}>✕</button>
          </div>
        ))}
        <label className="cs-filebtn">+ 손풀이 추가<input type="file" accept="image/*" onChange={addSolution} hidden /></label>
      </div>

      <div className="cs-field">
        <label>핵심 포인트 (AI에게 주는 지침)</label>
        <textarea className="cs-textarea" rows={3} placeholder="예: 이 문제는 판별식으로 접근하도록 안내해줘"
          value={points} onChange={e => setPoints(e.target.value)} />
      </div>

      <div className="cs-field">
        <label>동영상 강의 링크 (선택)</label>
        <input className="cs-input" placeholder="https://youtu.be/..." value={videoUrl} onChange={e => setVideoUrl(e.target.value)} />
      </div>

      <div className="cs-editor-actions">
        <button className="cs-btn" onClick={onCancel}>취소</button>
        <button className="cs-btn cs-btn-primary" disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
      </div>
    </div>
  )
}

function AdminStudents({ students, onAdd, onDelete }) {
  const [name, setName] = useState('')
  const [school, setSchool] = useState('동인고')
  const [grade, setGrade] = useState('고1')
  const [pw, setPw] = useState('')

  function add() {
    if (!name.trim() || !pw.trim()) { toast('이름과 뒤 4자리는 필수예요'); return }
    onAdd({ name: name.trim(), school: school.trim(), grade: grade.trim(), pw: pw.trim() })
    setName(''); setPw('')
  }

  return (
    <div className="cs-admin">
      <div className="cs-addstudent">
        <input className="cs-input" placeholder="이름" value={name} onChange={e => setName(e.target.value)} />
        <input className="cs-input cs-input-sm" placeholder="학교" value={school} onChange={e => setSchool(e.target.value)} />
        <input className="cs-input cs-input-sm" placeholder="학년" value={grade} onChange={e => setGrade(e.target.value)} />
        <input className="cs-input cs-input-sm" placeholder="뒤 4자리" maxLength={4} value={pw} onChange={e => setPw(e.target.value)} />
        <button className="cs-btn cs-btn-primary" onClick={add}>추가</button>
      </div>
      <div className="cs-muted">총 {students.length}명</div>
      <div className="cs-stud-list">
        {students.map(s => (
          <div key={s.name} className="cs-stud-item">
            <span><b>{s.name}</b> <small>{s.school} {s.grade}</small></span>
            <button className="cs-saved-del" onClick={() => { if (confirm(`${s.name} 삭제할까요?`)) onDelete(s.name) }}>삭제</button>
          </div>
        ))}
      </div>
    </div>
  )
}

function AdminLog({ qlog, worksheets }) {
  const wsName = (id) => worksheets.find(w => w.id === id)?.name || id || ''
  const top = {}
  for (const q of qlog) {
    const key = `${q.worksheet}::${q.problem}`
    top[key] = (top[key] || 0) + 1
  }
  const top5 = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5)

  return (
    <div className="cs-admin">
      <div className="cs-card">
        <b>질문 많은 문제 TOP 5</b>
        {top5.length === 0 ? <div className="cs-muted">아직 질문이 없어요.</div> :
          <ol className="cs-top5">
            {top5.map(([key, cnt]) => {
              const [ws, p] = key.split('::')
              return <li key={key}>{wsName(ws)} <b>{p}번</b> · {cnt}회</li>
            })}
          </ol>}
      </div>
      <div className="cs-card">
        <b>전체 질문 ({qlog.length})</b>
        <div className="cs-log-list">
          {qlog.map(q => (
            <div key={q.id} className="cs-log-item">
              <div className="cs-log-meta">{q.student} · {wsName(q.worksheet)} {q.problem}번</div>
              <div className="cs-log-q">{q.question}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   StyleBlock — 전역 CSS (cs- 접두사 / 네이비+골드)
============================================================ */
function StyleBlock() {
  return (
    <style>{`
    :root{ --navy:#2b3a8c; --navy-d:#222e6e; --gold:#d9a13a; --bg:#f4f5fa; --card:#fff; --line:#e6e8f0; --muted:#8a90a6; --text:#1f2430; }
    .cs-center{ min-height:60vh; display:flex; align-items:center; justify-content:center; }
    .cs-spinner{ width:34px; height:34px; border:3px solid #d8dcee; border-top-color:var(--navy); border-radius:50%; animation:spin .8s linear infinite; }
    @keyframes spin{ to{ transform:rotate(360deg) } }
    .cs-muted{ color:var(--muted); font-size:14px; padding:8px 2px; }

    .cs-page{ max-width:680px; margin:0 auto; padding:0 14px 60px; }
    .cs-header{ position:sticky; top:0; z-index:20; display:flex; align-items:center; justify-content:space-between;
      background:var(--navy); color:#fff; margin:0 -14px 12px; padding:12px 16px; }
    .cs-header-l{ display:flex; align-items:center; gap:10px; }
    .cs-header-title{ font-weight:800; font-size:17px; }
    .cs-header-sub{ font-size:12px; opacity:.8; }
    .cs-back{ background:rgba(255,255,255,.16); color:#fff; border:0; width:34px; height:34px; border-radius:9px; font-size:18px; cursor:pointer; }
    .cs-logout{ background:transparent; color:#fff; border:1px solid rgba(255,255,255,.5); border-radius:8px; padding:6px 10px; font-size:13px; cursor:pointer; }

    /* Login */
    .cs-login-wrap{ min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; background:#283163; }
    .cs-login-card{ width:100%; max-width:430px; background:#fff; border-radius:22px; padding:30px 28px; box-shadow:0 22px 55px rgba(0,0,0,.28); }
    .cs-brand{ display:flex; align-items:center; gap:14px; margin-bottom:22px; }
    .cs-brand-badge{ width:54px; height:54px; object-fit:contain; flex:0 0 auto; }
    .cs-brand-title{ font-weight:800; font-size:20px; color:#1f2430; line-height:1.25; }
    .cs-brand-sub{ color:var(--muted); font-size:13px; margin-top:2px; }
    .cs-flabel{ display:block; font-weight:700; font-size:14px; color:#3a4156; margin:14px 0 7px; }
    .cs-finput{ width:100%; border:1px solid #eceef4; background:#f4f5f9; border-radius:13px; padding:14px 15px; font-size:15px; outline:none; }
    .cs-finput:focus{ border-color:var(--navy); background:#fff; }
    .cs-loginbtn{ width:100%; margin-top:22px; border:0; background:var(--navy); color:#fff; border-radius:13px; padding:15px; font-weight:800; font-size:16px; cursor:pointer; }
    .cs-loginbtn:disabled{ opacity:.6; }
    .cs-modelink{ display:block; width:100%; margin-top:14px; background:transparent; border:0; color:var(--muted); font-size:14px; cursor:pointer; }
    .cs-header-logo{ width:30px; height:30px; object-fit:contain; flex:0 0 auto; }
    .cs-foot{ text-align:center; color:var(--muted); font-size:12px; margin-top:18px; letter-spacing:.3px; }

    .cs-input{ width:100%; border:1px solid var(--line); border-radius:11px; padding:12px 13px; font-size:15px; margin-bottom:10px; outline:none; }
    .cs-input:focus{ border-color:var(--navy); }
    .cs-input-sm{ width:auto; min-width:0; }
    .cs-err{ color:#d23b3b; font-size:13px; margin:2px 0 10px; }

    .cs-btn{ border:1px solid var(--line); background:#fff; border-radius:11px; padding:11px 15px; font-weight:700; cursor:pointer; font-size:15px; }
    .cs-btn-primary{ background:var(--navy); color:#fff; border-color:var(--navy); }
    .cs-btn-primary:disabled{ opacity:.6; }
    .cs-btn-block{ width:100%; }

    /* tabs / pills */
    .cs-tabs{ display:flex; gap:8px; margin-bottom:12px; }
    .cs-tabs button{ flex:1; border:1px solid var(--line); background:#fff; border-radius:11px; padding:10px; font-weight:700; color:var(--muted); cursor:pointer; }
    .cs-tabs button.on{ background:var(--navy); color:#fff; border-color:var(--navy); }
    .cs-pills{ display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
    .cs-pills button{ border:1px solid var(--line); background:#fff; border-radius:999px; padding:8px 13px; font-weight:700; color:#444; cursor:pointer; font-size:14px; }
    .cs-pills button.on{ background:var(--gold); color:#3a2a00; border-color:var(--gold); }
    .cs-pill-cnt{ opacity:.7; font-weight:600; margin-left:3px; }
    .cs-pill-add{ border-style:dashed !important; color:var(--navy) !important; }

    /* grid */
    .cs-grid{ display:grid; grid-template-columns:repeat(auto-fill, minmax(56px,1fr)); gap:9px; }
    .cs-cell{ aspect-ratio:1; border-radius:12px; border:1px solid var(--line); background:#fff; font-weight:800; font-size:17px; cursor:pointer; color:var(--text); }
    .cs-cell.ready{ background:#e8f4ea; border-color:#bfe3c7; color:#1f7a3a; }
    .cs-cell.partial{ background:#fdf6e3; border-color:#f0dca0; color:#9a7400; }
    .cs-cell.empty{ background:#fff; color:#aab; }

    .cs-legend{ display:flex; gap:14px; color:var(--muted); font-size:13px; margin:0 2px 10px; }
    .cs-legend .dot{ display:inline-block; width:11px; height:11px; border-radius:50%; margin-right:5px; vertical-align:-1px; }
    .cs-legend .dot.ready{ background:#48b06a; } .cs-legend .dot.partial{ background:#e3b53a; } .cs-legend .dot.empty{ background:#ccd; }
    .cs-add-row{ display:flex; gap:8px; margin-top:14px; }

    /* saved */
    .cs-saved-item{ display:flex; gap:8px; align-items:stretch; margin-bottom:9px; }
    .cs-saved-open{ flex:1; text-align:left; border:1px solid var(--line); background:#fff; border-radius:12px; padding:12px; cursor:pointer; display:flex; align-items:center; gap:8px; }
    .cs-tag{ background:#eef0f8; color:var(--navy); border-radius:6px; padding:2px 7px; font-size:12px; font-weight:700; }
    .cs-saved-note{ color:var(--muted); font-size:13px; }
    .cs-saved-del{ border:1px solid #f0c9c9; background:#fff5f5; color:#d23b3b; border-radius:10px; padding:0 12px; font-weight:700; cursor:pointer; }

    /* problem view */
    .cs-prob-actions{ display:flex; gap:8px; margin-bottom:12px; }
    .cs-star{ border:1px solid var(--line); background:#fff; border-radius:11px; padding:9px 13px; font-weight:700; cursor:pointer; }
    .cs-star.on{ background:#fff7e6; border-color:var(--gold); color:#8a6400; }
    .cs-video{ border:1px solid var(--line); background:#fff; border-radius:11px; padding:9px 13px; font-weight:700; text-decoration:none; color:var(--navy); }

    .cs-imgcard{ background:#fff; border:1px solid var(--line); border-radius:14px; padding:10px; margin-bottom:12px; }
    .cs-imgcard-label{ font-weight:800; font-size:13px; color:var(--muted); margin-bottom:8px; display:flex; align-items:center; justify-content:space-between; }
    .cs-imgcard img{ width:100%; border-radius:9px; display:block; }
    .cs-imgcard-empty{ color:var(--muted); text-align:center; padding:26px; font-size:14px; }

    .cs-region-toggle{ border:1px solid var(--line); background:#fff; border-radius:8px; padding:5px 9px; font-size:12px; font-weight:700; cursor:pointer; color:var(--navy); }
    .cs-region-toggle.on{ background:var(--navy); color:#fff; }
    .cs-soltabs{ display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
    .cs-soltabs button{ border:1px solid var(--line); background:#fff; border-radius:8px; padding:6px 10px; font-size:13px; font-weight:700; color:#555; cursor:pointer; }
    .cs-soltabs button.on{ background:var(--navy); color:#fff; border-color:var(--navy); }
    .cs-solwrap{ position:relative; }
    .cs-solwrap.selecting{ cursor:crosshair; }
    .cs-solwrap.selecting img{ user-select:none; }
    .cs-selbox{ position:absolute; border:2px solid var(--gold); background:rgba(217,161,58,.18); pointer-events:none; }

    .cs-note{ background:#fff; border:1px solid var(--line); border-radius:14px; padding:12px; margin-bottom:12px; }
    .cs-note-label{ font-weight:800; font-size:14px; margin-bottom:8px; }

    .cs-chat{ background:#fff; border:1px solid var(--line); border-radius:14px; padding:12px; }
    .cs-chat-label{ font-weight:800; font-size:14px; margin-bottom:8px; }
    .cs-chat-log{ max-height:360px; overflow:auto; display:flex; flex-direction:column; gap:8px; padding:4px 2px 8px; }
    .cs-bubble{ max-width:86%; padding:10px 12px; border-radius:13px; font-size:15px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
    .cs-bubble.user{ align-self:flex-end; background:var(--navy); color:#fff; border-bottom-right-radius:4px; }
    .cs-bubble.assistant{ align-self:flex-start; background:#eef0f8; color:var(--text); border-bottom-left-radius:4px; }
    .cs-typing{ opacity:.7; font-style:italic; }
    .cs-region-chip{ display:inline-flex; align-items:center; gap:6px; background:#fff7e6; border:1px solid var(--gold); color:#8a6400; border-radius:9px; padding:5px 9px; font-size:13px; margin:6px 0; }
    .cs-region-chip button{ border:0; background:transparent; cursor:pointer; color:#8a6400; font-weight:800; }

    .cs-chat-input{ display:flex; gap:8px; align-items:flex-end; margin-top:6px; }
    .cs-textarea{ width:100%; min-width:0; border:1px solid var(--line); border-radius:11px; padding:11px 12px; font-size:15px; outline:none; resize:vertical; }
    .cs-textarea:focus{ border-color:var(--navy); }
    .cs-send{ flex:0 0 auto; border:0; background:var(--navy); color:#fff; border-radius:11px; padding:11px 16px; font-weight:800; cursor:pointer; }
    .cs-send:disabled{ opacity:.5; }

    /* admin */
    .cs-admin{ display:block; }
    .cs-addws{ display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
    .cs-card{ background:#fff; border:1px solid var(--line); border-radius:14px; padding:14px; margin-bottom:12px; }
    .cs-top5{ margin:8px 0 0; padding-left:20px; }
    .cs-top5 li{ margin:4px 0; }
    .cs-log-list{ margin-top:8px; display:flex; flex-direction:column; gap:8px; max-height:480px; overflow:auto; }
    .cs-log-item{ border:1px solid var(--line); border-radius:10px; padding:9px 11px; }
    .cs-log-meta{ font-size:12px; color:var(--muted); margin-bottom:3px; }
    .cs-log-q{ font-size:14px; }

    .cs-addstudent{ display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
    .cs-addstudent .cs-input{ margin-bottom:0; }
    .cs-stud-list{ display:flex; flex-direction:column; gap:7px; margin-top:6px; }
    .cs-stud-item{ display:flex; align-items:center; justify-content:space-between; border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
    .cs-stud-item small{ color:var(--muted); }

    /* editor */
    .cs-editor{ }
    .cs-editor-head{ display:flex; align-items:center; gap:10px; margin-bottom:14px; font-size:17px; }
    .cs-editor-head .cs-back{ background:#eef0f8; color:var(--navy); }
    .cs-field{ background:#fff; border:1px solid var(--line); border-radius:12px; padding:12px; margin-bottom:12px; }
    .cs-field > label{ display:block; font-weight:800; font-size:13px; color:var(--muted); margin-bottom:8px; }
    .cs-thumb{ width:100%; border-radius:8px; margin-bottom:8px; }
    .cs-thumb-sm{ width:64px; height:64px; object-fit:cover; border-radius:8px; }
    .cs-sol-edit{ display:flex; align-items:center; gap:8px; margin-bottom:8px; }
    .cs-sol-edit .cs-input{ margin-bottom:0; }
    .cs-x{ border:1px solid #f0c9c9; background:#fff5f5; color:#d23b3b; border-radius:8px; width:30px; height:30px; cursor:pointer; font-weight:800; }
    .cs-filebtn{ display:inline-block; border:1px dashed var(--navy); color:var(--navy); border-radius:9px; padding:8px 12px; font-weight:700; cursor:pointer; font-size:14px; }
    .cs-editor-actions{ display:flex; gap:8px; justify-content:flex-end; }

    /* toast */
    .cs-toast{ position:fixed; left:50%; bottom:30px; transform:translateX(-50%) translateY(12px); background:#222; color:#fff;
      padding:10px 16px; border-radius:11px; font-size:14px; opacity:0; transition:.3s; z-index:99; }
    .cs-toast.show{ opacity:.96; transform:translateX(-50%) translateY(0); }
    `}</style>
  )
}
