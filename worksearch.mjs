#!/usr/bin/env node
/**
 * worksearch.mjs — Idaho work-search event log and weekly filing sheet.
 *
 * Unemployment benefits require reporting each work-search action to the state
 * within a weekly certification. career-ops already knows WHAT was applied to
 * and WHO it was with, but three things it tracks are wrong or missing for
 * this purpose, and each one is a filing error waiting to happen:
 *
 *   1. THE TRACKER DATE IS NOT THE ACTION DATE. `data/applications.md`'s Date
 *      column is the EVALUATION date: when a posting was scored, which is
 *      whenever a scan surfaced it. Submission happens later, by however long a
 *      shortlist sits. Checked against employer confirmation emails over one
 *      week, the drift ran 10 to 23 days on five applications, and on two more
 *      it crossed a week boundary and put the action in the WRONG CLAIM WEEK.
 *      It errs in both directions, so there is no correction factor; the two
 *      dates are simply unrelated. The action date is recorded here explicitly
 *      and is never inferred from a tracker row.
 *
 *   2. INTERVIEW ROUNDS HAVE NO STRUCTURED DATE ANYWHERE. `status-log.tsv`
 *      records one Evaluated -> Interview transition per application, not one
 *      row per round, so a candidate who interviews four times has one dated
 *      event. Round dates live only in `data/follow-ups.md` prose.
 *
 *   3. THE STATE WANTS THE EMPLOYER'S POSTAL ADDRESS. career-ops stores the
 *      JOB's location, which for a remote role is the candidate's own city, and
 *      the POSTING's URL, which is usually an ATS host (boards.greenhouse.io),
 *      not the company website. Neither is what the form asks for. Hence
 *      `data/employers.tsv`.
 *
 * Two files, because the form's fields vary along two different axes:
 *
 *   data/employers.tsv    per COMPANY: the postal address block. Written once
 *                         per employer, reused by every event at that employer.
 *   data/work-search.tsv  per EVENT, append-only: date, action type, job title,
 *                         and the answers only you can supply.
 *
 * `--week` re-joins them and prints one fully denormalized block per action, in
 * the portal's own field order. That denormalization is the point: Idaho's
 * portal does NOT remember an employer between entries, so the address block is
 * retyped for every single action. A company with fifteen open reqs you applied
 * to means fifteen retypings of one ZIP code from memory, at which point a typo
 * stops being unlikely and starts being scheduled.
 *
 * NOTHING HERE FILES ANYTHING. It prints what you type into the portal
 * yourself. It also does not decide what qualifies as a work-search action;
 * ACTION_TYPES is transcribed from the portal's own menu, and which ones you
 * are entitled to claim is between you and the Idaho Department of Labor.
 *
 * Run: node worksearch.mjs --week [YYYY-MM-DD]   (filing sheet; default: last week)
 *      node worksearch.mjs add --date ... --type ... --employer ... --title ...
 *      node worksearch.mjs employer add --name ... --address ... --city ...
 *      node worksearch.mjs employers            (JSON)
 *      node worksearch.mjs                      (JSON)
 *      node worksearch.mjs --summary
 *      node worksearch.mjs --self-test
 */

import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CAREER_OPS = getCareerOpsRoot();
const EVENTS_PATH = join(CAREER_OPS, 'data/work-search.tsv');
const EMPLOYERS_PATH = join(CAREER_OPS, 'data/employers.tsv');

/**
 * The portal's action menu, transcribed verbatim on 2026-08-30.
 *
 * Verbatim matters: the value is selected from a dropdown, so a paraphrase is
 * not a synonym, it is an option that does not exist. Stored in full rather
 * than as a code so the filing sheet prints the exact string to pick.
 */
export const ACTION_TYPES = [
  'Completed and submitted application to employer',
  'Submitted resume to employer',
  'Completed generic application',
  'Completed interview',
  'Upload completed resume to job board',
  'Attended job fair',
  'Completed job search workshop',
  'Completed job search assessment',
  'Completed job search plan/counseling',
  'Completed mock interview',
  'Took civil service exam',
  'Completed skills test with an employer',
  'Completed resume',
  'Completed cover letter',
  'Completed elevator speech',
  'Completed LinkedIn profile',
];

const EMPLOYER_HEADER = [
  '# employers.tsv — per-employer postal address block (user layer).',
  '# Rows are UPDATED IN PLACE when a detail changes (unlike the append-only logs).',
  '# {key}\\t{name}\\t{address1}\\t{address2|-}\\t{city}\\t{state}\\t{zip}\\t{country}\\t{website}\\t{phone|-}\\t{email|-}\\t{fax|-}\\t{source}\\t{verified}',
  '# key = lowercased alphanumerics of the name; the join key used by work-search.tsv.',
  '# An address that genuinely does not exist anywhere public is "None listed", not a guess.',
].join('\n');

const EVENT_HEADER = [
  '# work-search.tsv — append-only work-search action log (user layer). Never rewrite rows.',
  '# {action_date}\\t{action_type}\\t{employer_key}\\t{tracker#|-}\\t{job_title}\\t{job_number|-}',
  '#   \\t{confirmation|-}\\t{contact_name|-}\\t{contact_phone|-}\\t{submitted_yn}\\t{submitted_note|-}',
  '#   \\t{next_step}\\t{source}\\t{logged}',
  '# action_date is when the ACTION HAPPENED, never a tracker evaluation date.',
  '# submitted_yn answers the portal radio "Did you submit an application or resume',
  '#   between <claim start> and <claim end>?" — y | n. On n, submitted_note explains.',
  '# source records HOW the date was established (gmail-confirmation, calendar,',
  '#   follow-ups, user-stated). A date nobody can source is worth less than a blank.',
].join('\n');

// --- Keys ---

/** Join key for an employer name: lowercased alphanumerics, nothing else. */
export function employerKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// --- Week boundaries ---

/**
 * The Sunday-to-Saturday week containing `date`.
 *
 * Idaho certifies Sunday through Saturday, so a week is derived from the
 * calendar rather than from "seven days back". Constructed at UTC noon so a
 * local timezone offset can never roll the date across a day boundary and
 * silently shift the whole week by one.
 *
 * @param {string} date - Any YYYY-MM-DD inside the wanted week.
 * @returns {{start: string, end: string}} Inclusive ISO bounds.
 */
export function weekBounds(date) {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: "${date}"`);
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - d.getUTCDay());
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const iso = (x) => x.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

/** MM/DD/YYYY, the format the portal's date field expects. */
export function usDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || '');
}

/** Short weekday name, so a misfiled week is visible at a glance. */
export function weekday(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? '???'
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
}

// --- Parsing ---

const norm = (v) => (v === '' || v === '-' ? null : v);

function splitRows(content) {
  return String(content || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export function parseEmployers(content) {
  const employers = {};
  const malformed = [];
  for (const line of splitRows(content)) {
    const c = line.split('\t').map((x) => x.trim());
    const [key, name, address1, address2, city, state, zip, country, website, phone, email, fax, source, verified] = c;
    if (c.length < 9 || !key || !name) {
      malformed.push({ line: line.slice(0, 80) });
      continue;
    }
    employers[key] = {
      key,
      name,
      address1: norm(address1),
      address2: norm(address2),
      city: norm(city),
      state: norm(state),
      zip: norm(zip),
      country: norm(country) || 'United States',
      website: norm(website),
      phone: norm(phone),
      email: norm(email),
      fax: norm(fax),
      source: norm(source),
      verified: norm(verified),
    };
  }
  return { employers, malformed };
}

export function parseEvents(content) {
  const rows = [];
  const malformed = [];
  for (const line of splitRows(content)) {
    const c = line.split('\t').map((x) => x.trim());
    const [actionDate, actionType, employer, trackerNum, jobTitle, jobNumber,
      confirmation, contactName, contactPhone, submittedYn, submittedNote,
      nextStep, source, logged] = c;
    if (c.length < 5 || !/^\d{4}-\d{2}-\d{2}$/.test(actionDate || '') || !actionType || !employer || !jobTitle) {
      malformed.push({ line: line.slice(0, 80) });
      continue;
    }
    rows.push({
      actionDate,
      actionType,
      employer,
      trackerNum: norm(trackerNum),
      jobTitle,
      jobNumber: norm(jobNumber),
      confirmation: norm(confirmation),
      contactName: norm(contactName),
      contactPhone: norm(contactPhone),
      submitted: String(submittedYn || '').toLowerCase() === 'y',
      submittedNote: norm(submittedNote),
      nextStep: norm(nextStep),
      source: norm(source),
      logged: norm(logged),
      unknownActionType: !ACTION_TYPES.includes(actionType),
    });
  }
  rows.sort((a, b) => (a.actionDate === b.actionDate ? 0 : a.actionDate < b.actionDate ? -1 : 1));
  return { rows, malformed };
}

// --- Loading ---

function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

export function load() {
  const { employers, malformed: badEmployers } = parseEmployers(read(EMPLOYERS_PATH));
  const { rows, malformed: badEvents } = parseEvents(read(EVENTS_PATH));
  return { employers, rows, badEmployers, badEvents };
}

// --- The filing sheet ---

/**
 * Join events in a week against employer records, flagging every gap that
 * would stop the form from being submittable.
 *
 * Missing data is reported rather than filled. A required field the tool cannot
 * source is a question for the user; inventing a plausible ZIP code would make
 * a government filing wrong in a way nothing downstream could detect.
 */
export function buildSheet(rows, employers, { start, end }) {
  const inWeek = rows.filter((r) => r.actionDate >= start && r.actionDate <= end);
  return inWeek.map((r) => {
    const emp = employers[r.employer] || null;
    const gaps = [];
    if (!emp) {
      gaps.push(`no employer record for "${r.employer}" — run: worksearch.mjs employer add --name "..."`);
    } else {
      for (const f of ['address1', 'city', 'state', 'zip', 'website']) {
        if (!emp[f]) gaps.push(`employer "${emp.name}" is missing ${f} (a required field)`);
      }
    }
    if (!r.nextStep) gaps.push('next step is blank (a required field)');
    if (!r.submitted && !r.submittedNote) gaps.push('answered No to the submitted-in-window question with no explanation');
    if (r.unknownActionType) gaps.push(`"${r.actionType}" is not one of the portal's ${ACTION_TYPES.length} action types`);
    return { event: r, employer: emp, gaps };
  });
}

const FIELDS = [
  ['Action Date', (e) => usDate(e.event.actionDate)],
  ['Contact Name', (e) => e.event.contactName],
  ['Contact Phone', (e) => e.event.contactPhone],
  ['Confirmation #', (e) => e.event.confirmation],
  ['Company Name', (e) => e.employer?.name],
  ['Company Address', (e) => e.employer?.address1],
  ['Address Line 2', (e) => e.employer?.address2],
  ['Country', (e) => e.employer?.country],
  ['City', (e) => e.employer?.city],
  ['State', (e) => e.employer?.state],
  ['ZIP Code', (e) => e.employer?.zip],
  ['Company Website', (e) => e.employer?.website],
  ['Company Email', (e) => e.employer?.email],
  ['Company Fax', (e) => e.employer?.fax],
  ['Type of Work or Job Title', (e) => e.event.jobTitle],
  ['Job Number', (e) => e.event.jobNumber],
];

export function printSheet(sheet, { start, end }) {
  console.log('');
  console.log(`  Work-search filing sheet — week of ${usDate(start)} (Sun) through ${usDate(end)} (Sat)`);
  console.log(`  ${sheet.length} action${sheet.length === 1 ? '' : 's'}. Nothing here is filed for you.`);
  console.log('');

  if (!sheet.length) {
    console.log('  No actions logged for this week.');
    console.log('  If that is wrong, the actions happened but were never logged — check Gmail');
    console.log('  confirmations and interview invites for the window, then `worksearch.mjs add`.');
    console.log('');
    return;
  }

  const width = Math.max(...FIELDS.map(([label]) => label.length));
  sheet.forEach((entry, i) => {
    const { event } = entry;
    console.log(`  ─── [${i + 1}/${sheet.length}] ${weekday(event.actionDate)} ${event.actionDate} ${'─'.repeat(30)}`);
    console.log(`  Action: ${event.actionType}`);
    if (event.trackerNum) console.log(`  (tracker #${event.trackerNum}, date sourced from: ${event.source || 'unrecorded'})`);
    console.log('');
    for (const [label, get] of FIELDS) {
      const v = get(entry);
      console.log(`    ${label.padEnd(width)} : ${v || '(leave blank)'}`);
    }
    console.log('');
    console.log(`    Did you submit an application or resume between ${usDate(start)} and ${usDate(end)}?`);
    console.log(`      → ${event.submitted ? 'Yes' : 'No'}`);
    if (!event.submitted && event.submittedNote) console.log(`      Why: ${event.submittedNote}`);
    console.log('');
    console.log('    What is the next step with this job search action?');
    console.log(`      → ${event.nextStep || '(REQUIRED — not recorded)'}`);
    console.log('');
    if (entry.gaps.length) {
      console.log('    ⚠ blockers:');
      for (const g of entry.gaps) console.log(`      - ${g}`);
      console.log('');
    }
  });

  const blocked = sheet.filter((e) => e.gaps.length).length;
  console.log(blocked
    ? `  ⚠ ${blocked} of ${sheet.length} entries have missing required data (see blockers above).`
    : '  All entries have every required field.');
  console.log('');
}

// --- Appending ---

function flagValue(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : '';
}

function cell(raw, { required = false, name = '' } = {}) {
  const v = String(raw ?? '').trim();
  if (required && !v) throw new Error(`--${name} is required`);
  if (v.includes('\t') || v.includes('\n')) throw new Error(`--${name} must not contain tabs or newlines`);
  return v || '-';
}

function ensureFile(path, header) {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${header}\n`, 'utf-8');
}

export function buildEventRow(f, today) {
  const date = cell(f.date, { required: true, name: 'date' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must be YYYY-MM-DD, got "${date}"`);
  const type = cell(f.type, { required: true, name: 'type' });
  if (!ACTION_TYPES.includes(type)) {
    throw new Error(`--type must be one of the portal's action types verbatim. Got "${type}".\nValid:\n  ${ACTION_TYPES.join('\n  ')}`);
  }
  const submitted = String(f.submitted ?? '').trim().toLowerCase();
  if (!['y', 'n', 'yes', 'no'].includes(submitted)) throw new Error('--submitted must be y or n');
  const yn = submitted.startsWith('y') ? 'y' : 'n';
  if (yn === 'n' && !String(f.why ?? '').trim()) {
    throw new Error('--why is required when --submitted n (the portal asks why, and a blank is not an answer)');
  }
  return [
    date,
    type,
    employerKey(cell(f.employer, { required: true, name: 'employer' })),
    cell(f.tracker, { name: 'tracker' }),
    cell(f.title, { required: true, name: 'title' }),
    cell(f.jobNumber, { name: 'job-number' }),
    cell(f.confirmation, { name: 'confirmation' }),
    cell(f.contact, { name: 'contact' }),
    cell(f.phone, { name: 'phone' }),
    yn,
    cell(f.why, { name: 'why' }),
    cell(f.next, { required: true, name: 'next' }),
    cell(f.source, { name: 'source' }),
    today,
  ].join('\t');
}

export function buildEmployerRow(f, today) {
  const name = cell(f.name, { required: true, name: 'name' });
  return [
    employerKey(name),
    name,
    cell(f.address, { required: true, name: 'address' }),
    cell(f.address2, { name: 'address2' }),
    cell(f.city, { required: true, name: 'city' }),
    cell(f.state, { required: true, name: 'state' }),
    cell(f.zip, { required: true, name: 'zip' }),
    cell(f.country || 'United States', { name: 'country' }),
    cell(f.website, { required: true, name: 'website' }),
    cell(f.phone, { name: 'phone' }),
    cell(f.email, { name: 'email' }),
    cell(f.fax, { name: 'fax' }),
    cell(f.source, { name: 'source' }),
    cell(f.verified || today, { name: 'verified' }),
  ].join('\t');
}

function addEvent(args) {
  const row = buildEventRow({
    date: flagValue(args, 'date'),
    type: flagValue(args, 'type'),
    employer: flagValue(args, 'employer'),
    tracker: flagValue(args, 'tracker'),
    title: flagValue(args, 'title'),
    jobNumber: flagValue(args, 'job-number'),
    confirmation: flagValue(args, 'confirmation'),
    contact: flagValue(args, 'contact'),
    phone: flagValue(args, 'phone'),
    submitted: flagValue(args, 'submitted'),
    why: flagValue(args, 'why'),
    next: flagValue(args, 'next'),
    source: flagValue(args, 'source'),
  }, localToday());
  ensureFile(EVENTS_PATH, EVENT_HEADER);
  appendFileSync(EVENTS_PATH, `${row}\n`, 'utf-8');
  console.log(`logged: ${row.split('\t').slice(0, 5).join(' | ')}`);
}

/**
 * Upsert an employer. Unlike the event log this rewrites in place, because an
 * address is current state rather than an observation: a company that moves has
 * one address, and two rows for one key would make the join ambiguous.
 */
function addEmployer(args) {
  const row = buildEmployerRow({
    name: flagValue(args, 'name'),
    address: flagValue(args, 'address'),
    address2: flagValue(args, 'address2'),
    city: flagValue(args, 'city'),
    state: flagValue(args, 'state'),
    zip: flagValue(args, 'zip'),
    country: flagValue(args, 'country'),
    website: flagValue(args, 'website'),
    phone: flagValue(args, 'phone'),
    email: flagValue(args, 'email'),
    fax: flagValue(args, 'fax'),
    source: flagValue(args, 'source'),
    verified: flagValue(args, 'verified'),
  }, localToday());
  const key = row.split('\t')[0];
  ensureFile(EMPLOYERS_PATH, EMPLOYER_HEADER);
  const lines = readFileSync(EMPLOYERS_PATH, 'utf-8').split('\n');
  let replaced = false;
  const out = lines.map((l) => {
    const t = l.trim();
    if (!t || t.startsWith('#')) return l;
    if (t.split('\t')[0].trim() === key) { replaced = true; return row; }
    return l;
  });
  if (!replaced) {
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push(row);
  }
  writeFileSync(EMPLOYERS_PATH, `${out.join('\n').replace(/\n+$/, '')}\n`, 'utf-8');
  console.log(`${replaced ? 'updated' : 'added'} employer: ${key}`);
}

// --- Self-test ---

function selfTest() {
  let failures = 0;
  const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) { failures += 1; console.error(`  FAIL ${label}\n    got:      ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}`); }
    else console.log(`  ok   ${label}`);
  };
  const throws = (label, fn, re) => {
    try { fn(); failures += 1; console.error(`  FAIL ${label} (expected a throw)`); }
    catch (e) {
      if (re && !re.test(e.message)) { failures += 1; console.error(`  FAIL ${label}\n    message: ${e.message}`); }
      else console.log(`  ok   ${label}`);
    }
  };

  console.log('worksearch self-test\n');

  // A claim week runs Sunday to Saturday; every day inside it agrees.
  check('week from its Sunday', weekBounds('2026-08-23'), { start: '2026-08-23', end: '2026-08-29' });
  check('week from its Saturday', weekBounds('2026-08-29'), { start: '2026-08-23', end: '2026-08-29' });
  check('week from midweek', weekBounds('2026-08-26'), { start: '2026-08-23', end: '2026-08-29' });
  // The day after a claim week belongs to the NEXT one. This is the exact edge
  // an evaluation-date guess gets wrong, filing an action in the wrong week.
  check('the next day rolls the week', weekBounds('2026-08-30'), { start: '2026-08-30', end: '2026-09-05' });

  check('us date', usDate('2026-08-24'), '08/24/2026');
  check('weekday', weekday('2026-08-24'), 'Mon');
  check('employer key folds punctuation', employerKey('Acme Health, Inc.'), 'acmehealthinc');

  const emp = parseEmployers([
    '# comment',
    'acmecorp\tAcme Corp\t1 Example Way\tSuite 400\tSpringfield\tIL\t62701\tUnited States\thttps://example.com\t-\t-\t-\tsec-10k\t2026-01-01',
    'junk',
  ].join('\n'));
  check('employer parsed', emp.employers.acmecorp.city, 'Springfield');
  check('employer dash is null', emp.employers.acmecorp.phone, null);
  check('malformed employer counted', emp.malformed.length, 1);

  const ev = parseEvents([
    '2026-08-24\tCompleted interview\tacmecorp\t101\tStaff Engineer\t-\t-\tJane Doe\t-\tn\tApplied earlier\tAwaiting decision\tcalendar\t2026-08-30',
    '2026-08-29\tCompleted and submitted application to employer\tglobex\t102\tSenior Engineer\t-\t-\t-\t-\ty\t-\tAwaiting response\tgmail-confirmation\t2026-08-30',
    'not-a-date\tCompleted interview\tx\t-\tT\t',
  ].join('\n'));
  check('events parsed', ev.rows.length, 2);
  check('events sorted by action date', ev.rows[0].actionDate, '2026-08-24');
  check('submitted y parses true', ev.rows[1].submitted, true);
  check('malformed event counted', ev.malformed.length, 1);

  const sheet = buildSheet(ev.rows, emp.employers, weekBounds('2026-08-26'));
  check('both events land in the week', sheet.length, 2);
  check('employer joined', sheet[0].employer.zip, '62701');
  // The second event references an employer with no record, so the address
  // block cannot be filled. That has to surface as a blocker, never as a
  // silently blank required field on a government form.
  check('missing employer is a blocker', sheet[1].gaps.length > 0, true);

  throws('rejects a paraphrased action type', () => buildEventRow({
    date: '2026-08-24', type: 'Interviewed', employer: 'X', title: 'T', submitted: 'n', why: 'w', next: 'n',
  }, '2026-08-30'), /action types verbatim/);
  throws('rejects submitted=n with no explanation', () => buildEventRow({
    date: '2026-08-24', type: 'Completed interview', employer: 'X', title: 'T', submitted: 'n', next: 'n',
  }, '2026-08-30'), /--why is required/);
  throws('rejects a non-ISO date', () => buildEventRow({
    date: '08/24/2026', type: 'Completed interview', employer: 'X', title: 'T', submitted: 'y', next: 'n',
  }, '2026-08-30'), /must be YYYY-MM-DD/);
  throws('employer requires a ZIP', () => buildEmployerRow({
    name: 'X', address: 'A', city: 'C', state: 'S', website: 'W',
  }, '2026-08-30'), /--zip is required/);

  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

// --- CLI ---

const USAGE = `Usage:
  node worksearch.mjs --week [YYYY-MM-DD]     # filing sheet for that Sun-Sat week (default: last week)
  node worksearch.mjs add --date YYYY-MM-DD --type "<portal action type>" \\
       --employer "<company>" --title "<job title>" --submitted y|n [--why "..."] \\
       --next "<next step>" [--tracker N] [--job-number X] [--confirmation X] \\
       [--contact "<name>"] [--phone X] [--source gmail-confirmation|calendar|follow-ups|user-stated]
  node worksearch.mjs employer add --name "<company>" --address "<street>" [--address2 "<suite>"] \\
       --city "<city>" --state XX --zip NNNNN --website <url> [--country ...] [--phone/--email/--fax] \\
       [--source "<where this came from>"]
  node worksearch.mjs employers                # employer registry as JSON
  node worksearch.mjs                          # event log as JSON
  node worksearch.mjs --summary                # human-readable roll-up
  node worksearch.mjs --types                  # the portal's action types, verbatim
  node worksearch.mjs --self-test`;

function printSummary({ rows, employers }) {
  const byType = {};
  const byWeek = {};
  for (const r of rows) {
    byType[r.actionType] = (byType[r.actionType] || 0) + 1;
    const { start } = weekBounds(r.actionDate);
    byWeek[start] = (byWeek[start] || 0) + 1;
  }
  console.log('\n  Work-search log\n');
  console.log(`  ${rows.length} action(s) across ${Object.keys(byWeek).length} week(s); ${Object.keys(employers).length} employer record(s)\n`);
  console.log('  By week (Sun start):');
  for (const w of Object.keys(byWeek).sort()) console.log(`    ${w}  ${String(byWeek[w]).padStart(3)}`);
  console.log('\n  By action type:');
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)}  ${t}`);
  const missing = rows.filter((r) => !employers[r.employer]);
  if (missing.length) {
    console.log(`\n  ⚠ ${missing.length} action(s) reference an employer with no address record:`);
    for (const k of [...new Set(missing.map((r) => r.employer))]) console.log(`      ${k}`);
  }
  console.log('');
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
  if (args.includes('--self-test')) { selfTest(); return; }
  if (args.includes('--types')) { ACTION_TYPES.forEach((t) => console.log(t)); return; }
  if (args[0] === 'add') { addEvent(args.slice(1)); return; }
  if (args[0] === 'employer' && args[1] === 'add') { addEmployer(args.slice(2)); return; }

  const { employers, rows, badEmployers, badEvents } = load();

  if (args[0] === 'employers') { console.log(JSON.stringify({ employers, malformed: badEmployers }, null, 2)); return; }

  if (args.includes('--week')) {
    const i = args.indexOf('--week');
    const anchor = args[i + 1] && !args[i + 1].startsWith('--')
      ? args[i + 1]
      // Default to LAST week, not this one: a certification is filed after the
      // week closes, so the week you are asking about is the one just ended.
      : new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const bounds = weekBounds(anchor);
    printSheet(buildSheet(rows, employers, bounds), bounds);
    return;
  }

  if (args.includes('--summary')) { printSummary({ rows, employers }); return; }
  console.log(JSON.stringify({ events: rows, employers, malformed: { employers: badEmployers, events: badEvents } }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
