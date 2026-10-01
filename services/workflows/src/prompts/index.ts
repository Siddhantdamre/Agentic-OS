import {
  OBLIGATION_CLASSIFIER_TEMPLATE,
  OBLIGATION_CLASSIFIER_VERSION,
} from './obligation-classifier.v1.js';
import {
  OBLIGATION_EXTRACTOR_TEMPLATE,
  OBLIGATION_EXTRACTOR_VERSION,
} from './obligation-extractor.v1.js';

export {
  OBLIGATION_CLASSIFIER_TEMPLATE,
  OBLIGATION_CLASSIFIER_VERSION,
} from './obligation-classifier.v1.js';
export {
  OBLIGATION_EXTRACTOR_TEMPLATE,
  OBLIGATION_EXTRACTOR_VERSION,
} from './obligation-extractor.v1.js';

export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : ''
  );
}

export function promptTemplate(kind: 'classifier' | 'extractor'): string {
  switch (kind) {
    case 'classifier':
      return OBLIGATION_CLASSIFIER_TEMPLATE;
    case 'extractor':
      return OBLIGATION_EXTRACTOR_TEMPLATE;
    default: {
      const _never: never = kind;
      return _never;
    }
  }
}

export function promptVersion(kind: 'classifier' | 'extractor'): string {
  switch (kind) {
    case 'classifier':
      return OBLIGATION_CLASSIFIER_VERSION;
    case 'extractor':
      return OBLIGATION_EXTRACTOR_VERSION;
    default: {
      const _never: never = kind;
      return _never;
    }
  }
}
