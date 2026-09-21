import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import rulesMarkdown from '../../../../docs/RULES.md?raw';
import { strings } from '../strings';

export function Rules() {
  return (
    <div className="page rules-page">
      <header className="rules-header">
        <span className="rules-brand">{strings.rulesHeader}</span>
        <span className="rules-subtitle">{strings.rulesSubtitle}</span>
      </header>
      <main className="rules-body">
        <Markdown remarkPlugins={[remarkGfm]}>{rulesMarkdown}</Markdown>
      </main>
    </div>
  );
}
