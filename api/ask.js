// /api/ask  — AI 튜터 프록시 (Anthropic 키 사용). 서버에서만 키 보관.
// body: { problem, history, question, region }
//  problem = { id, problemImg, solutionImg, points }  (현재 보고 있는 손풀이 기준)
//  history = [{ role:'user'|'assistant', text }]
//  region  = { highlight?: dataURL, zoom?: dataURL, coords?: '%' } (선택)

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'

const SYSTEM_PROMPT = `너는 동인고등학교 1학년 학생들을 가르치는 따뜻하고 친절한 수학 선생님이야.
학생은 학습지 문제와 '선생님 손풀이'를 보고 있고, 그중 막히는 부분을 너에게 물어본다.
- 학생이 지금 보고 있는 손풀이를 기준으로, 어디서 왜 그렇게 되는지 그 단계를 이해시키는 데 집중해라.
- 정답만 던지지 말고, 학생이 스스로 다음 단계를 떠올릴 수 있게 차근차근 안내해라.
- 한국어로, 고1 학생이 알아듣는 말투로, 너무 길지 않게 답해라.
- 수식은 정확한 텍스트로 또박또박 써라(예: x^2, √, ≤, × 등). 잘못된 풀이로 유도하지 마라.
- 손풀이에 없는 다른 풀이로 갈아타지 말고, 학생이 보고 있는 풀이를 먼저 이해시켜라.`

function imageBlockFromUrl(url) {
  if (!url) return null
  return { type: 'image', source: { type: 'url', url } }
}
function imageBlockFromDataUrl(dataUrl) {
  if (!dataUrl || !dataUrl.startsWith('data:')) return null
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
  if (!m) return null
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return }
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) { res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY 미설정' }); return }

    const { problem = {}, history = [], question = '', region = null } = req.body || {}

    const messages = []

    // 1) 첫 user 턴: 문제 + 현재 손풀이 이미지 + 핵심 포인트
    const firstContent = []
    const probImg = imageBlockFromUrl(problem.problemImg)
    const solImg = imageBlockFromUrl(problem.solutionImg)
    if (probImg) { firstContent.push({ type: 'text', text: '[문제 이미지]' }); firstContent.push(probImg) }
    if (solImg) { firstContent.push({ type: 'text', text: '[학생이 지금 보고 있는 선생님 손풀이]' }); firstContent.push(solImg) }
    let intro = '위 문제와 손풀이를 학생이 보고 있어. 학생의 질문에 이 손풀이를 기준으로 답해줘.'
    if (problem.points && String(problem.points).trim()) {
      intro += `\n\n선생님 핵심 포인트(이 방향으로 안내할 것): ${String(problem.points).trim()}`
    }
    firstContent.push({ type: 'text', text: intro })
    messages.push({ role: 'user', content: firstContent })
    messages.push({ role: 'assistant', content: '네, 문제와 손풀이를 봤어요. 어디가 궁금한지 말해줄래요?' })

    // 2) 이전 대화기록
    for (const turn of history) {
      if (!turn || !turn.text) continue
      messages.push({ role: turn.role === 'assistant' ? 'assistant' : 'user', content: turn.text })
    }

    // 3) 이번 질문 (+ 영역 선택 이미지/좌표)
    const lastContent = []
    if (region) {
      const zoom = imageBlockFromDataUrl(region.zoom)
      const hi = imageBlockFromDataUrl(region.highlight)
      if (zoom) { lastContent.push({ type: 'text', text: '[학생이 손풀이에서 가리킨 부분을 확대한 이미지]' }); lastContent.push(zoom) }
      else if (hi) { lastContent.push({ type: 'text', text: '[학생이 손풀이에서 표시한 부분]' }); lastContent.push(hi) }
      else if (region.coords) { lastContent.push({ type: 'text', text: `학생이 손풀이에서 가리킨 위치(대략): ${region.coords}` }) }
    }
    lastContent.push({ type: 'text', text: question || '이 부분이 이해가 안 돼요.' })
    messages.push({ role: 'user', content: lastContent })

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: SYSTEM_PROMPT, messages })
    })
    const data = await r.json()
    if (!r.ok) { res.status(500).json({ ok: false, error: data?.error?.message || 'Anthropic 오류' }); return }
    const answer = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
    res.status(200).json({ ok: true, answer })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
}
