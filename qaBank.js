/**
 * Rule-based answer bank for Naukri's post-Apply screening questions
 * ("chatbot" style quick questions some recruiters attach to a job).
 *
 * Bias: soft screening questions (relocate / reside / comfortable / willing)
 * always answer Yes to maximize shortlist chances — a "No" here is often an
 * instant auto-reject.
 */
import { CONFIG } from "./config.js";

const c = CONFIG.candidate;

/** Sentinel meaning "recognized this question, but intentionally leave the
 * field exactly as Naukri prefilled it from your profile — never touch it." */
export const SKIP = "__SKIP_FIELD__";

function norm(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

const SKILL_NAMES = Object.keys(c.skills).sort((a, b) => b.length - a.length);

function findSkillInQuestion(q) {
  for (const skill of SKILL_NAMES) {
    const re = new RegExp(`(?:^|[^a-z0-9])${skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z0-9])`, "i");
    if (re.test(q)) return skill;
  }
  return null;
}

function pickYesNo(options, boolValue) {
  if (!options || options.length === 0) return boolValue ? "Yes" : "No";
  const want = boolValue ? "yes" : "no";
  const found = options.find((o) => norm(o) === want);
  if (found) return found;
  const fuzzy = options.find((o) => norm(o).includes(want));
  return fuzzy || (boolValue ? "Yes" : "No");
}

function pickOption(options, candidates) {
  if (!options) return candidates[0];
  for (const cand of candidates) {
    const found = options.find((o) => norm(o) === norm(cand));
    if (found) return found;
  }
  for (const cand of candidates) {
    const found = options.find((o) => norm(o).includes(norm(cand)));
    if (found) return found;
  }
  return null;
}

/**
 * Soft Yes/No screening questions where answering "No" tanks shortlist odds.
 * Always Yes — relocate / reside / interview availability / comfortable / etc.
 */
function isFavorableYesQuestion(q) {
  return (
    /relocat/.test(q) ||
    /resid(e|ing)|currently (live|living|based|stay|staying)/.test(q) ||
    /(open|willing|ready) to (relocat|move|join|work)/.test(q) ||
    /comfortable|would you be (able|willing)|are you (open|willing|ok|okay)/.test(q) ||
    /fine working|flexible (with|to)|able to work|willing to work/.test(q) ||
    /hybrid|work from (home|office)|wfh|remote/.test(q) ||
    // Interview availability — e.g. "Should be available for F2F interview on Monday..."
    /available for.*(interview|f2f|face.?to.?face|walk.?in)/.test(q) ||
    /(f2f|face.?to.?face|walk.?in).*(interview|on )/.test(q) ||
    /available.*(monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(st|nd|rd|th)?)/.test(q) ||
    /can you (attend|join|come|appear)/.test(q) ||
    /notice period.*(serve|serving|immediate)/.test(q) ||
    /authoriz|legally.*work|work.*(permit|visa|status)|background check|drug test|consent to/.test(q)
  );
}

function isJoiningTimelineQuestion(q) {
  return (
    /\blwd\b/.test(q) ||
    /last working (day|date)/.test(q) ||
    /last (day|date) (at|of|with) (work|current|previous)/.test(q) ||
    /notice period|notice days?/.test(q) ||
    /how soon can you (join|start)/.test(q) ||
    /when can you (join|start)/.test(q) ||
    /joining availability|available to join/.test(q)
  );
}

function answerJoiningTimeline(field, options) {
  if (field.type === "number") return "0";
  if (field.type === "radio" || field.type === "select") {
    const immediate = pickOption(options, [
      "Immediate",
      "Immediately",
      "0",
      "0 days",
      "0-15 days",
      "0-30 days",
      "Less than 30 days",
      "Serving notice period",
    ]);
    if (immediate) return immediate;
    if (options.some((option) => norm(option) === "yes")) return pickYesNo(options, true);
  }
  return "Immediate";
}

function isAICodingToolsQuestion(q) {
  return (
    /ai (coding|developer|development) tools?/.test(q) ||
    /github copilot|claude code|cursor|windsurf|codeium|tabnine/.test(q)
  );
}

/**
 * @param {string} questionText
 * @param {{type: string, options?: string[]}} field
 * @returns {string|null}
 */
export function matchKnownAnswer(questionText, field = {}) {
  const q = norm(questionText);
  const options = (field.options || []).filter(
    (o) => o && !/select an option|skip this question/i.test(o)
  );
  const isChoice = field.type === "radio" || field.type === "select";

  if (/^email/.test(q) && !/other/.test(q)) return SKIP;
  if (/^(full )?name/.test(q)) return SKIP;

  // Candidate guidance: LWD/last-working-date/notice-period questions mean
  // immediate availability. Numeric fields receive zero days.
  if (isJoiningTimelineQuestion(q)) {
    return answerJoiningTimeline(field, options);
  }

  // Candidate guidance: confirm regular use of AI-assisted coding tools.
  if (isAICodingToolsQuestion(q)) {
    return isChoice ? pickYesNo(options, true) : "Yes";
  }

  // Soft screening → always Yes (shortlist bias). Matches e.g.
  // "Are you currently residing in Hyderabad... or willing to relocate...?"
  if (isFavorableYesQuestion(q)) {
    return pickYesNo(options, true);
  }

  if (/years?.*(experience|work(ed)?|worked)/.test(q) || /experience.*years?/.test(q)) {
    const skill = findSkillInQuestion(q);
    if (skill != null) {
      const years = c.skills[skill];
      return isChoice ? pickOption(options, [String(years), `${years}+`]) ?? String(years) : String(years);
    }
    // Candidate guidance: use total experience for technologies that are not
    // individually listed in candidate.skills.
    const years = String(c.totalYearsExperience);
    return isChoice ? pickOption(options, [years, `${years}+`, `${years} years`]) ?? years : years;
  }

  if (/(level of education|bachelor|master|degree)/.test(q) && /(completed|have you|do you have)/.test(q)) {
    return pickYesNo(options, c.educationCompleted);
  }

  if (/sponsor/.test(q)) {
    return pickYesNo(options, c.requiresSponsorship);
  }

  // Combined free-text chat question, e.g.
  // "What is your current CTC and expected annual CTC in INR?"
  if (/current/.test(q) && /expected/.test(q) && /ctc|salary|compensation/.test(q)) {
    return `CTC - ${c.currentCtcLpa} LPA / ECTC - ${c.expectedCtcLpa} LPA`;
  }

  if (/(current.*(ctc|salary|compensation|pay))/.test(q)) {
    return /lpa|lakh/.test(q) ? String(c.currentCtcLpa) : String(c.currentCtcLpa * 100000);
  }

  if (/(expected.*(ctc|salary|compensation|pay)|salary expectation|expected.*(lpa|pay))/.test(q)) {
    return /lpa|lakh/.test(q) ? String(c.expectedCtcLpa) : String(c.expectedCtcLpa * 100000);
  }

  if (/(phone|mobile) number/.test(q)) return c.phone;

  if (/(reason for (job )?change|why.*looking|why.*leaving)/.test(q)) {
    return "Looking for better growth opportunities and a chance to work on more challenging problems.";
  }

  if (/(gender|race|ethnicity|veteran|disability)/.test(q)) {
    return (
      pickOption(options, [
        "Prefer not to say",
        "Decline to answer",
        "I don't wish to answer",
      ]) || null
    );
  }

  // Any remaining Yes/No choice with a question mark → favor Yes for shortlist
  if (isChoice && options.some((o) => /^yes$/i.test(norm(o))) && /\?/.test(q)) {
    return pickYesNo(options, true);
  }

  return null;
}

export default matchKnownAnswer;
