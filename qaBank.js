import { CONFIG } from './config.js';
import { createQuestionBank } from '../shared/questionBank.js';

export { SKIP, isNonAnswerOption } from '../shared/questionBank.js';

export const matchKnownAnswer = createQuestionBank(
  () => CONFIG.candidate,
  () => ({
    skipPrefilledIdentity: true,
    unknownSkillYears: 'total',
    favorableUnknownYesNo: true,
    ambiguousNumericSalary: 'inr',
    ambiguousTextSalary: 'inr',
  }),
);

export default matchKnownAnswer;
