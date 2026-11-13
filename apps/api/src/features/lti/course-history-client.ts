export const courseHistoryClientScript = String.raw`
/**
 * Owner history uses the native VideoQ history/CSV contract in both LMS viewers.
 * @copyright 2026 VideoQ contributors
 * @license http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
function createCourseHistory(root, request, seek, chatElements, copy, renderText) {
    const tabs = root.querySelector('[data-course-history-tabs]');
    const chat = root.querySelector('[data-course-chat-tab]');
    const history = root.querySelector('[data-course-history-tab]');
    const panel = root.querySelector('[data-course-history-panel]');
    const content = root.querySelector('[data-course-history-content]');
    const status = root.querySelector('[data-course-history-status]');
    const download = root.querySelector('[data-course-history-csv]');
    let allowed = false, selected = false, sequence = 0, busy = false;
    function select(value) {
        selected = value && allowed;
        panel.hidden = !selected;
        chatElements.forEach(element => { element.hidden = selected; });
        chat.setAttribute('aria-pressed', String(!selected));
        history.setAttribute('aria-pressed', String(selected));
        chat.classList.toggle('active', !selected); history.classList.toggle('active', selected);
    }
    function availability(value) {
        allowed = value === true;
        tabs.hidden = !allowed;
        if (!allowed) { ++sequence; content.replaceChildren(); status.textContent = ''; select(false); }
    }
    function node(tag, text, className) {
        const element = document.createElement(tag);
        element.textContent = text || ''; element.className = className || ''; return element;
    }
    async function load() {
        if (!allowed || busy) return;
        busy = true;
        const current = ++sequence;
        status.textContent = copy.loading; content.replaceChildren(); download.disabled = true; download.hidden = true;
        try {
            const response = await request({action: 'list'});
            if (current !== sequence) return;
            if (!response.ok) { if ([401,403].includes(response.status)) availability(false); throw new Error(); }
            const data = await response.json();
            if (current !== sequence) return;
            if (!Array.isArray(data.results) || !Number.isInteger(data.count)) throw new Error();
            for (const item of data.results) {
                const card = node('article', '', 'qa-card');
                card.append(node('p', new Date(item.created_at).toLocaleString() + ' · ' + (item.asked_by?.username || copy.shared) + (item.asked_by?.email ? ' · ' + item.asked_by.email : ''), 'qa-meta'));
                card.append(node('p', item.question, 'qa-body'));
                for (const segment of item.answer.segments) {
                    const body = node('div', '', 'qa-body');
                    if (renderText) renderText(body, segment.text); else body.textContent = segment.text;
                    card.append(body);
                }
                for (const source of item.answer.sources || []) {
                    const button = node('button', source.title + ' ' + source.start_time, 'btn btn-outline-secondary btn-sm');
                    button.type = 'button'; button.addEventListener('click', () => seek(source)); card.append(button);
                }
                if (item.feedback) card.append(node('small', item.feedback === 'good' ? 'Good' : 'Bad'));
                content.append(card);
            }
            if (!data.results.length) content.append(node('p', copy.empty));
            download.hidden = !data.results.length;
            status.textContent = '';
        } catch { if (current === sequence && allowed) status.textContent = copy.error; }
        finally { busy = false; if (allowed) download.disabled = false; }
    }
    chat.addEventListener('click', () => select(false));
    history.addEventListener('click', () => { select(true); void load(); });
    download.addEventListener('click', async () => {
        if (!allowed || busy) return;
        download.disabled = true;
        const current = sequence;
        try {
            const response = await request({action: 'csv'});
            if (current !== sequence || !allowed) return;
            if (!response.ok) { if ([401,403].includes(response.status)) availability(false); throw new Error(); }
            const blob = await response.blob();
            if (current !== sequence || !allowed) return;
            const url = URL.createObjectURL(blob), link = document.createElement('a');
            link.href = url; link.download = 'videoq-course-history.csv'; document.body.append(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        } catch { if (allowed) status.textContent = copy.error; }
        finally { download.disabled = !allowed; }
    });
    availability(false);
    return {availability};
}
`;
