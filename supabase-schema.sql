-- ============================================================
--  동인고 학습지 풀이 앱 (Costudy) — 통합 스키마 (한 번에 실행)
--  사직여고 버전의 최종 상태(학습지 기능 포함)를 새 프로젝트용으로 정리한 것.
--  Supabase → SQL Editor 에 붙여넣고 1회 Run.
-- ============================================================

-- ---------- 1. 학습지(worksheets) ----------
create table if not exists worksheets (
  id          text primary key,
  name        text not null,
  count       int  not null default 0,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

-- ---------- 2. 문제(problems) : PK = (worksheet, id) ----------
create table if not exists problems (
  worksheet    text not null,
  id           int  not null,
  problem_img  text,
  solution_img text,                       -- 레거시/대표(solutions[0] 동기화)
  solutions    jsonb not null default '[]'::jsonb,  -- [{img,label}, ...]
  points       text default '',            -- "핵심 포인트" = AI에게 주는 지침
  video_url    text default '',
  updated_at   timestamptz not null default now(),
  primary key (worksheet, id)
);

-- ---------- 3. 학생(students) = 로그인 계정 ----------
create table if not exists students (
  name   text primary key,                 -- 로그인 아이디(이름)
  school text,
  grade  text,
  pw     text not null                      -- 휴대폰 뒤 4자리(문자열, 0 보존)
);

-- ---------- 4. 학생 개인공간(student_problem) : PK = (student, worksheet, problem) ----------
create table if not exists student_problem (
  student    text not null,
  worksheet  text not null,
  problem    int  not null,
  saved      boolean not null default false,
  note       text default '',
  chat       jsonb not null default '[]'::jsonb,   -- [{role,text}, ...]
  updated_at timestamptz not null default now(),
  primary key (student, worksheet, problem)
);

-- ---------- 5. 질문 로그(question_log) ----------
create table if not exists question_log (
  id         bigint generated always as identity primary key,
  student    text,
  problem    int,
  worksheet  text,
  question   text,
  created_at timestamptz not null default now()
);

-- ============================================================
--  RLS (Row Level Security)
-- ============================================================
alter table worksheets       enable row level security;
alter table problems         enable row level security;
alter table students         enable row level security;   -- anon 정책 없음 → 서버리스에서만 접근
alter table student_problem  enable row level security;
alter table question_log     enable row level security;

-- 공개 읽기
drop policy if exists ws_public_read on worksheets;
create policy ws_public_read on worksheets for select using (true);

drop policy if exists problems_public_read on problems;
create policy problems_public_read on problems for select using (true);

-- 학생 개인공간: 내부용 단순 정책(전체 허용)
drop policy if exists sp_anon_all on student_problem;
create policy sp_anon_all on student_problem for all using (true) with check (true);

-- 질문 로그: anon은 insert만
drop policy if exists qlog_anon_insert on question_log;
create policy qlog_anon_insert on question_log for insert with check (true);

-- ============================================================
--  스토리지 버킷 (공개)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('problem-images', 'problem-images', true)
on conflict (id) do update set public = true;

drop policy if exists problem_images_public_read on storage.objects;
create policy problem_images_public_read on storage.objects
  for select using (bucket_id = 'problem-images');

-- ============================================================
--  시드 데이터 (동인고1)
-- ============================================================

-- 학습지 3개 (단원명/문항수만 동인고1로)
insert into worksheets (id, name, count, sort_order) values
  ('eq',  '여러 가지 방정식과 부등식', 13, 1),
  ('pc',  '순열과 조합',             13, 2),
  ('mat', '행렬',                   13, 3)
on conflict (id) do update set name = excluded.name, count = excluded.count, sort_order = excluded.sort_order;

-- 학생 명단 (중복 제거 / pw = 학생 연락처 뒤 4자리 / 동명이인 정지우 A·B 분리)
insert into students (name, school, grade, pw) values
  ('최인수','동인고','고1','2872'),
  ('전민규','동인고','고1','1473'),
  ('주예준','동인고','고1','7970'),
  ('제의진','동인고','고1','5450'),
  ('장형욱','동인고','고1','3141'),
  ('김세현','동인고','고1','5442'),
  ('구도윤','동인고','고1','4899'),
  ('심재윤','용인고','고1','9571'),
  ('정지우A','동인고','고1','1685'),
  ('정민성','동인고','고1','2623'),
  ('이지홍','동인고','고1','5795'),
  ('배주한','동인고','고1','3437'),
  ('이준우','동인고','고1','5953'),
  ('김지후A','동인고','고1','4015'),
  ('김규현','동인고','고1','4744'),
  ('신윤준','동인고','고1','3598'),
  ('김태윤','동인고','고1','8455'),
  ('손동근','동인고','고1','5557'),
  ('남정윤','동인고','고1','2520'),
  ('박시영','동인고','고1','8525'),
  ('정성욱','동인고','고1','6929'),
  ('손민준','동인고','고1','3792'),
  ('서지혁','동인고','고1','4220'),
  ('손현담','동인고','고1','2390'),
  ('김민찬','동인고','고1','9693'),
  ('이서준C','동인고','고1','1459'),
  ('이동건','동인고','고1','5756'),
  ('권지윤','동인고','고1','1599'),
  ('이재열','동인고','고1','3894'),
  ('이종훈','동인고','고1','0585'),
  ('배신영','동인고','고1','4660'),
  ('장원준','동인고','고1','4007'),
  ('권태현','동인고','고1','9550'),
  ('정지우B','동인고','고1','1935'),
  ('이선재','동인고','고1','1528'),
  ('서성원','동인고','고1','0473')
on conflict (name) do update set school = excluded.school, grade = excluded.grade, pw = excluded.pw;

-- 이름이 비어 있던 명단 34행(연락처 010-4740-2266 / 010-2458-2266)은 제외함.
-- 이름 확인되면 아래 한 줄의 주석을 풀고 이름/뒤4자리를 채워 실행:
-- insert into students (name, school, grade, pw) values ('이름입력','동인고','고1','2266') on conflict (name) do nothing;
