import type { SiteLocale } from '@/lib/seo';

export interface GuideSection {
  heading: string;
  paragraphs: string[];
  steps?: string[];
}

export interface GuideBody {
  intro: string;
  sections: GuideSection[];
}

// State only shipped behaviour here, checked against docs/concepts. No invented
// figures, customers, testimonials or promised results.
export const GUIDE_BODIES: Record<string, Record<SiteLocale, GuideBody>> = {
  'online-course-questions': {
    ja: {
      intro: '動画講座を販売・運営していると、受講生から同じような質問が繰り返し届きます。このガイドでは、VideoQで受講生の質問に講義動画から自動で回答できるようにして、受講生が自分で答えにたどり着ける状態をつくる手順と、始める前に確認したい点を説明します。',
      sections: [
        {
          heading: '質問対応の負担はどこで生まれるか',
          paragraphs: [
            '受講生の質問には、講義のどこかですでに説明している内容が含まれていることがあります。答え自体は動画にあっても、数時間の講座から該当の場面を探すのは受講生にとって手間がかかるため、講師への質問になります。',
            'そこで効果が見込めるのは、講師が答える件数を増やすことではなく、すでに話した説明へ受講生を案内することです。VideoQの回答には根拠になった場面の時間が付くため、受講生はそのまま講義の該当箇所へ戻れます。',
          ],
        },
        {
          heading: '一般的なAIチャットとの違い',
          paragraphs: [
            '一般的なAIチャットは、講師の授業内容を前提に答えるわけではありません。受講生が使うと、講義と異なる用語や説明の順序で答えが返ることがあります。',
            'VideoQのAIは、講座に登録された動画の文字起こしから質問に関係する場面を探し、その内容をもとに回答します。講師の説明に沿った答えと、確認に使える引用元の場面を一緒に示せる点が違いです。',
          ],
        },
        {
          heading: 'サンプル講座で、質問から復習までを確かめる',
          paragraphs: [
            '登録なしで試せるサンプル講座には、微分などを扱う短い講義が入っています。たとえば「x²を微分するとどうなりますか？」と質問すると、講義で説明している「2x」という答えと、その説明に使った動画の場面を確認できます。これはサンプルの内容に基づく例で、回答の文章や引用される範囲は質問ごとに変わります。',
            '答えだけを読むのではなく、引用を開いて講義を再生し、質問への説明が実際に含まれているかを確認してください。この流れを先に体験すると、自分の講座でもどんな質問を試すべきか判断しやすくなります。ページ下部の「登録なしで質問してみる」から開けます。サンプルにも利用上限があります。',
          ],
          steps: [
            '講義内で説明している内容を質問し、回答と引用先の説明が一致するかを確認します。',
            '回答の根拠となった場面を再生し、受講生が続きの説明を見直せるかを確かめます。',
            '自分の講座では、講義で扱っていない質問も試し、根拠が不十分な回答を受講生に案内してしまわないかを確認します。',
          ],
        },
        {
          heading: '公開までの手順',
          paragraphs: ['まずは1本の講義で動作を確かめてから、残りの動画を追加すると判断しやすくなります。'],
          steps: [
            '講義動画をアップロードします。MP4・MOV・WebMなどに対応し、文字起こしが自動で行われます。ご自身が利用する権利のある動画をお使いください。',
            '講座を作成し、質問の対象にする動画を追加します。AIが参照するのは、その講座に含まれる動画です。',
            '受講生が聞きそうな質問をご自身で試し、回答と引用された場面を確認します。',
            '共有リンクを発行するか、メンバーを招待して受講生に案内します。',
          ],
        },
        {
          heading: '共有リンクと招待の選び方',
          paragraphs: [
            '共有リンクは、URLを知っている人がログインなしで動画を視聴し、質問できる方式です。受講生の準備がいらない一方、リンクは転送できるため、最初に送った相手だけに限定はできません。履歴上は共有経由の質問として記録され、誰が聞いたかは表示されません。',
            '招待は、メールアドレスを指定して送る方式です。受講生は、宛先と一致する確認済みメールアドレスのアカウントでログインして参加します。販売した講座の視聴者を限定したい場合はこちらが向いています。',
          ],
        },
        {
          heading: '費用と利用上限',
          paragraphs: [
            'AIの回答は講座の所有者の利用枠から使われ、受講生に費用はかかりません。利用枠は講座や受講生ごとではなくアカウント全体で共有され、上限に達すると新しい質問は受け付けられなくなります。受講生の人数と質問の量を見込んで、プランの上限を確認してください。',
          ],
        },
        {
          heading: '始める前に確認したいこと',
          paragraphs: [
            'AIの回答や文字起こしには誤りが含まれることがあります。受講生には、AIの回答であることと、引用された場面で内容を確認できることを伝えてください。また、質問と回答の履歴は講座の所有者が閲覧・CSV出力できます。受講生の質問を講師が読むことも、あらかじめ案内しておくと安心です。',
          ],
        },
      ],
    },
    en: {
      intro: 'If you sell or run a video course, students keep sending similar questions. This guide explains how to answer questions automatically from your lectures with VideoQ so students can reach answers themselves, and what to confirm before you start.',
      sections: [
        {
          heading: 'Where the support workload comes from',
          paragraphs: [
            'Some student questions cover something a lecture has already explained. The answer exists, but finding the moment in hours of video is work for the student, so they ask the instructor instead.',
            'The useful change is not answering more messages. It is pointing students back to the explanation you already gave. Each VideoQ answer carries the time of its source moment, so students can return to that part of the lecture.',
          ],
        },
        {
          heading: 'How this differs from a general AI chat',
          paragraphs: [
            'A general AI chat does not assume what you taught. A student using one may get terminology or an order of explanation that differs from your course.',
            'VideoQ looks through the transcripts of the videos in your course for scenes related to the question, then answers from them. Students get an answer that follows your explanation, along with the cited moment they can use to check it.',
          ],
        },
        {
          heading: 'Try the path from a question back to a lecture',
          paragraphs: [
            'The sample course, available without signing up, includes short lectures on topics such as differentiation. For example, ask “What is the derivative of x²?” and check the lecture’s explanation that the answer is 2x, together with the cited video moment. This example comes from the sample material; the wording and cited range can vary between questions.',
            'Open the citation and play the lecture to check that it supports the answer. Trying this first helps you choose questions to test with your own course. Use “Ask without signing up” below to open the sample. Usage limits apply to the sample too.',
          ],
          steps: [
            'Ask something the lecture explains, then compare the answer with the cited explanation.',
            'Play the source moment and check that a student can continue watching the explanation.',
            'In your own course, also test questions the lectures do not cover, and check whether an answer lacks enough evidence before sharing it with students.',
          ],
        },
        {
          heading: 'Steps to publish',
          paragraphs: ['Test one lecture first. It is easier to decide on adding the rest once you have seen the results.'],
          steps: [
            'Upload a lecture. MP4, MOV, WebM and other formats are supported, and transcription runs automatically. Use only videos you have the right to use.',
            'Create a course and add the videos to cover. The AI refers to the videos in that course.',
            'Ask the questions you expect from students, and check the answers and cited moments.',
            'Create a share link or invite members, then tell your students.',
          ],
        },
        {
          heading: 'Choosing a share link or invitations',
          paragraphs: [
            'With a share link, anyone holding the URL can watch the videos and ask questions without signing in. Students need no setup, but a link can be forwarded, so it is not limited to the people you sent it to. These questions are logged as coming through the link, without identifying who asked.',
            'Invitations go to specific email addresses. A student joins by signing in to an account whose verified email matches. This suits a paid course where you want to limit who has access.',
          ],
        },
        {
          heading: 'Costs and limits',
          paragraphs: [
            'AI answers use the course owner’s allowance, and students pay nothing. The allowance is shared across your account rather than split by course or student. At the limit, new questions are refused. Estimate your student numbers and question volume, then check the plan limits.',
          ],
        },
        {
          heading: 'What to confirm before you start',
          paragraphs: [
            'AI answers and transcripts can contain mistakes. Tell students that answers come from AI and can be checked against the cited moment. The course owner can also read and export question and answer history as CSV, so let students know in advance that you can read their questions.',
          ],
        },
      ],
    },
  },
  'class-recordings-for-review': {
    ja: {
      intro: '塾やスクールで授業を録画していても、見返すのは長い動画の中から必要な説明を探す作業になりがちです。このガイドでは、VideoQで授業の録画を、生徒が質問しながら復習できる教材にする方法を説明します。',
      sections: [
        {
          heading: '録画を置くだけでは復習に使いにくい理由',
          paragraphs: [
            '欠席した回を最初から見るのは時間がかかり、試験前に特定の説明だけを見返したい場合は、どの回のどこで話したかを思い出す必要があります。生徒が質問を言葉にできれば、説明の場面まで案内するのがVideoQの役割です。',
          ],
        },
        {
          heading: '講座の分け方',
          paragraphs: [
            'AIは講座に含まれる動画をもとに答えます。範囲が広すぎると別の単元の説明が混ざり、狭すぎると関連する説明に届きません。科目や学期、試験範囲など、生徒が一緒に質問したい単位でまとめてください。',
            '同じ動画を複数の講座に入れることもできるので、まず単元で分け、試験前に範囲をまとめた講座を別に作る方法も取れます。',
          ],
        },
        {
          heading: '生徒への案内のしかた',
          paragraphs: ['クラス全体に配るなら共有リンクが手軽です。在籍する生徒に限定したい場合は、メンバー招待を使います。'],
          steps: [
            '録画をアップロードして講座にまとめます。',
            '想定される質問を試し、答えと引用された場面を確認します。',
            '共有リンクか招待を生徒に送ります。',
            '回答を鵜呑みにせず、示された場面で説明を確かめるよう伝えます。',
          ],
        },
        {
          heading: '質問履歴を授業に活かす',
          paragraphs: [
            '講座の所有者は、質問と回答の履歴を確認し、CSVで出力できます。同じ箇所に質問が集まっていれば、次の授業で補足する候補になります。招待した生徒の質問にはユーザー名とメールアドレスが表示され、共有リンク経由の質問では質問者は表示されません。',
          ],
        },
        {
          heading: '導入前に確認したいこと',
          paragraphs: [
            '録画に生徒の声や姿が含まれる場合は、教室の方針に沿って扱いを確認してください。質問の内容は講座の所有者が読めるため、そのことを生徒と保護者に説明しておくことをおすすめします。AIの回答には誤りが含まれることがあるため、指導の代わりではなく、講師の説明へ戻るための入口として位置づけてください。',
          ],
        },
      ],
    },
    en: {
      intro: 'Schools often record classes, but reviewing them usually means hunting through long videos for one explanation. This guide explains how to use VideoQ to turn class recordings into review material students can ask questions about.',
      sections: [
        {
          heading: 'Why recordings alone are hard to review with',
          paragraphs: [
            'Watching a missed lesson from the start takes time, and revisiting one explanation before an exam means remembering which lesson covered it. If a student can put the question into words, VideoQ points them to the moment it was explained.',
          ],
        },
        {
          heading: 'How to divide courses',
          paragraphs: [
            'The AI answers from the videos in a course. Too broad a course can mix in explanations from other units, and too narrow a course can miss related ones. Group videos in the units students would ask about together, such as a subject, term or exam range.',
            'The same video can belong to several courses, so you can divide by unit first, then create a separate course covering an exam range.',
          ],
        },
        {
          heading: 'How to introduce it to students',
          paragraphs: ['A share link is the simple way to reach a whole class. To limit access to enrolled students, use member invitations.'],
          steps: [
            'Upload the recordings and group them into a course.',
            'Try the questions you expect, and check the answers and cited moments.',
            'Send students the share link or invitations.',
            'Ask them to check answers against the cited moment rather than taking them at face value.',
          ],
        },
        {
          heading: 'Using question history in class',
          paragraphs: [
            'The course owner can review question and answer history and export it as CSV. If questions cluster around one point, it may be worth revisiting next lesson. Questions from invited students show a username and email address. Questions through a share link do not identify who asked.',
          ],
        },
        {
          heading: 'What to confirm before you start',
          paragraphs: [
            'If recordings include students’ voices or images, check how your school’s policy applies. The course owner can read questions, so we recommend explaining this to students and guardians. AI answers can contain mistakes, so treat them as a route back to the teacher’s explanation rather than a replacement for teaching.',
          ],
        },
      ],
    },
  },
  'training-video-questions': {
    ja: {
      intro: '研修動画は、受講したあとに「あの手順はどこで説明していたか」を探し直すことが多い教材です。このガイドでは、VideoQで研修動画に質問できるようにする方法と、社内で使い始める前に決めておきたいことを説明します。',
      sections: [
        {
          heading: '研修のあとに困るのはどんなときか',
          paragraphs: [
            '業務で必要になってから動画を見返そうとしても、どの研修のどの場面か分からないと探すだけで時間がかかり、結局は担当者に聞くことになります。研修動画に質問できれば、従業員は自分の言葉で聞いて、説明の場面を確認できます。',
          ],
        },
        {
          heading: '研修ごとに講座をつくる',
          paragraphs: [
            '新人研修、業務マニュアル、コンプライアンス研修など、質問の範囲がそろう単位で講座をつくります。AIが参照するのは講座に含まれる動画だけなので、動画で説明していない社内ルールや、その後に変更された内容には答えられません。',
          ],
          steps: [
            '研修動画をアップロードします。文字起こしが自動で行われます。',
            '研修の単位で講座をつくり、動画を追加します。',
            '現場でよく聞かれる質問を試して、回答と引用された場面を確認します。',
            '対象の従業員を招待します。',
          ],
        },
        {
          heading: '閲覧範囲は招待で限定する',
          paragraphs: [
            '社内向けの動画には、基本的にメンバー招待が向いています。招待された人は、宛先と一致する確認済みメールアドレスのアカウントで承認して参加します。共有リンクはURLを知っている人なら誰でも使えるため、社外に出したくない動画には使わないでください。',
            '異動や退職のときは、メンバーを講座から削除すると、その参加経路での新しい閲覧と質問ができなくなります。共有リンクを別に発行している場合は、リンクの無効化も必要です。',
          ],
        },
        {
          heading: '質問履歴で確認できること',
          paragraphs: [
            '講座の所有者は、質問と回答の履歴を閲覧・CSV出力できます。招待した従業員の質問には、ユーザーIDやユーザー名、メールアドレスが表示されます。誰の質問か分かることを、利用前に従業員へ案内してください。',
          ],
        },
        {
          heading: '社内で使い始める前に決めること',
          paragraphs: [
            '動画に機密情報が含まれる場合は、社内の規程に照らしてアップロードの可否を確認してください。AIの回答や文字起こしには誤りが含まれることがあるため、経理や労務など正確さが求められる手続きでは、引用された場面や正式な規程を確認する運用にしてください。また、AIの利用枠はアカウント全体で共有されるので、対象人数に合うプランを確認してください。',
          ],
        },
      ],
    },
    en: {
      intro: 'After training ends, people often need to find where a procedure was explained. This guide explains how to let staff ask questions about training videos with VideoQ, and what to decide before rolling it out.',
      sections: [
        {
          heading: 'Where people get stuck after training',
          paragraphs: [
            'When a task comes up, finding the right training and the right moment takes time, so people end up asking the person in charge. If they can ask the training videos directly, they can use their own words and then check the explanation.',
          ],
        },
        {
          heading: 'Create a course for each training program',
          paragraphs: [
            'Create courses in units with a consistent scope, such as onboarding, procedures or compliance. The AI refers only to the videos in the course, so it cannot answer about rules the videos do not cover, or about changes made since recording.',
          ],
          steps: [
            'Upload the training videos. Transcription runs automatically.',
            'Create a course per program and add the videos.',
            'Try the questions people commonly ask, and check the answers and cited moments.',
            'Invite the staff who need access.',
          ],
        },
        {
          heading: 'Limit access with invitations',
          paragraphs: [
            'Member invitations generally suit internal videos. An invited person accepts by signing in to an account whose verified email matches. A share link works for anyone holding the URL, so do not use one for videos that should stay inside your organization.',
            'When someone moves on, removing them from the course stops new reads and questions through that membership. If you also issued a share link, disable that as well.',
          ],
        },
        {
          heading: 'What question history shows',
          paragraphs: [
            'The course owner can read question and answer history and export it as CSV. Questions from invited staff show a user ID, username and email address. Let staff know beforehand that questions are attributable to them.',
          ],
        },
        {
          heading: 'What to decide before rollout',
          paragraphs: [
            'If videos contain confidential information, check your internal rules before uploading. AI answers and transcripts can contain mistakes, so for procedures that need precision, such as accounting or HR, have people check the cited moment and the official policy. The AI allowance is shared across the account, so confirm the plan suits your headcount.',
          ],
        },
      ],
    },
  },
  'how-ai-answers-work': {
    ja: {
      intro: 'このガイドでは、VideoQが講義動画から回答を作るまでの流れと、回答の限界、質問の内容を誰が閲覧できるかを説明します。受講生に案内する前の確認にお使いください。',
      sections: [
        {
          heading: '動画を質問に使える状態にする',
          paragraphs: [
            'アップロードした動画は音声を取り出して文字起こしし、時刻付きのテキストにします。そのテキストを場面ごとに分け、意味の近さで検索できるようにします。YouTubeから登録する場合は、音声の文字起こしではなく既存の字幕を取得します。この登録には利用者のSearchAPIキーが必要です。',
          ],
        },
        {
          heading: '質問から回答ができるまで',
          paragraphs: ['質問を受け取ると、次の流れで回答を作ります。'],
          steps: [
            '質問者がその講座を利用できるかを確認します。',
            'AIが講座内の場面を検索し、必要に応じて前後の字幕や、アップロード動画の静止画を確認します。',
            '見つけた内容をもとに回答を作り、根拠の場面を引用として付けます。',
            '受講生は、引用の時間から講義の該当箇所を再生できます。',
          ],
        },
        {
          heading: '回答を確認するときの見方',
          paragraphs: [
            '引用はAIの答えが正しいことの保証ではありません。音声の聞き取り違いや場面の解釈違いが起こることがあります。また、画面だけに映っていて話していない内容や、短い動作は読み取れない場合があります。公開前に、受講生が聞きそうな質問を試して、回答と引用された場面を見比べてください。',
          ],
        },
        {
          heading: '質問の内容を誰が閲覧できるか',
          paragraphs: [
            '保存された質問と回答を閲覧・CSV出力・削除できるのは、講座の所有者だけです。招待された参加者の質問には質問者の情報が表示され、共有リンク経由の質問は、ログインしていても質問者が表示されません。ただし、質問文に書いた内容は所有者が読めます。',
            '参加者の削除や共有リンクの無効化では履歴は消えません。保存された会話を消すには、講座の履歴削除を別に行います。この操作は講座全体の履歴が対象で、出力済みのCSVは消えません。',
          ],
        },
        {
          heading: '利用できる量の決まり方',
          paragraphs: [
            '質問への回答は講座の所有者の利用枠を使います。回答を作る前に枠を確保し、完了できなかった場合は返却を試みます。上限に達すると、所有者・参加者・共有リンク利用者のいずれからの新しい質問も受け付けられません。短時間に集中した場合は、枠が残っていても一時的に制限されることがあります。',
          ],
        },
      ],
    },
    en: {
      intro: 'This guide explains how VideoQ builds answers from your lecture videos, where those answers have limits, and who can read the questions. Use it to check before you introduce VideoQ to students.',
      sections: [
        {
          heading: 'Preparing a video for questions',
          paragraphs: [
            'For an uploaded video, VideoQ extracts the audio and transcribes it into timestamped text. The text is split into scenes and made searchable by meaning. A YouTube import retrieves existing subtitles rather than transcribing audio, and needs your own SearchAPI key.',
          ],
        },
        {
          heading: 'From question to answer',
          paragraphs: ['When a question arrives, VideoQ follows these steps.'],
          steps: [
            'It checks that the person asking can use the course.',
            'The AI searches scenes in the course and, as needed, reads surrounding subtitles or still images from uploaded videos.',
            'It writes an answer from what it found, citing the source moments.',
            'The student can play that part of the lecture from the cited time.',
          ],
        },
        {
          heading: 'How to check an answer',
          paragraphs: [
            'A citation does not guarantee that an answer is right. Audio can be misheard and scenes misinterpreted. Content shown on screen but not spoken, or brief actions, may also be missed. Before publishing, try the questions you expect from students, and compare the answers with the cited moments.',
          ],
        },
        {
          heading: 'Who can read the questions',
          paragraphs: [
            'Only the course owner can read, export as CSV or delete saved questions and answers. Questions from invited members show who asked. Questions through a share link do not, even if the person is signed in, although the owner can still read whatever the question itself says.',
            'Removing a member or disabling a share link does not delete history. To remove saved conversations, delete the course history separately. That applies to the whole course and does not erase CSV files already exported.',
          ],
        },
        {
          heading: 'How usage is counted',
          paragraphs: [
            'Answers use the course owner’s allowance. VideoQ reserves usage before writing an answer and attempts to return it if the answer cannot be completed. At the limit, new questions are refused from the owner, members and share link users alike. Heavy bursts can also be limited temporarily while allowance remains.',
          ],
        },
      ],
    },
  },
};
