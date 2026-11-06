import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    'README',
    {
      type: 'category',
      label: 'Get started',
      collapsed: false,
      items: [
        'getting-started/local-setup',
        'getting-started/first-walkthrough',
        'getting-started/codebase',
        'getting-started/first-change',
      ],
    },
    {
      type: 'category',
      label: 'AI behavior',
      collapsed: false,
      items: [
        'concepts/how-ai-works',
        'architecture/transcription-and-search',
        'architecture/prompt-engineering',
        'architecture/structured-answers',
        'reference/ai-references',
      ],
    },
    {
      type: 'category',
      label: 'Core concepts',
      items: [
        'concepts/domain-model',
        'architecture/system-configuration-diagram',
        'concepts/auth',
        'concepts/course-sharing',
        'guides/lms-integration',
      ],
    },
    {
      type: 'category',
      label: 'Development guides',
      items: [
        'guides/frontend',
        'guides/api',
        'guides/database',
        'guides/embeddings',
        'guides/visual-evidence',
        'guides/worker',
        'guides/testing',
        'guides/troubleshooting',
        'guides/documentation',
      ],
    },
    {
      type: 'category',
      label: 'Design reference',
      items: [
        {
          type: 'category',
          label: 'API and processing',
          items: [
            'architecture/trpc-api',
            'architecture/flowchart',
            'architecture/bpmn',
          ],
        },
        {
          type: 'category',
          label: 'Database',
          items: ['database/er-diagram', 'database/data-dictionary', 'database/data-flow-diagram'],
        },
        {
          type: 'category',
          label: 'Screens and features',
          items: [
            'requirements/use-case-diagram',
            'requirements/activity-diagram',
            'requirements/screen-transition-diagram',
          ],
        },
        {
          type: 'category',
          label: 'Modules and state',
          items: [
            'design/component-diagram',
            'design/class-diagram',
            'design/sequence-diagram',
            'design/state-diagram',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Operations',
      items: ['guides/on-premises', 'guides/on-premises-single-server',
          'guides/on-premises-k3s', 'guides/local-inference', 'guides/on-premises-releases', 'design/deployment-diagram', 'billing/stripe-dashboard'],
    },
    'reference/glossary',
  ],
};

export default sidebars;
