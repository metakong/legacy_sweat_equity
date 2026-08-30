/**
 * Pipeline View — B2B Deal-Flow CRM.
 *
 * Two coordinated surfaces:
 *   Mobile (<1024px):  Vertical Action Queue with Segmented Control (NOW, TODAY, WEEK, WON)
 *   Desktop (≥1024px): Horizontal 6-column Kanban Board with real-time stage transitions
 */

import { $, el, showToast, setButtonBusy, apiFetch, apiPost, activateView, businessDate } from './ui.js';
import { applyCompany, setBinaryToggles } from './field.js';

let pipelineData = [];
let currentSegment = 'NOW';
let activeSnoozeCompanyId = null;

export async function fetchPipelineData() {
  try {
    const data = await apiFetch('/api/pipeline?limit=500');
    pipelineData = data.pipeline || [];
    renderPipeline();
  } catch (err) {
    console.error('Failed to load pipeline:', err);
    showToast('Failed to load pipeline data.', 'error');
  }
}

/**
 * Determine urgency level of an account based on next_action_date and days_in_stage.
 */
function getUrgency(company, today) {
  if (company.pipeline_stage === 'CLOSED_WON') return 'won';
  if (!company.next_action_date) {
    return (company.days_in_stage || 0) >= 14 ? 'today' : 'idle';
  }
  if (company.next_action_date < today) return 'overdue';
  if (company.next_action_date === today) return 'today';
  return 'upcoming';
}

function matchesSegment(company, segment, today) {
  if (segment === 'WON') {
    return company.pipeline_stage === 'CLOSED_WON';
  }
  if (company.pipeline_stage === 'CLOSED_WON' || company.pipeline_stage === 'CLOSED_LOST') {
    return false;
  }

  const urgency = getUrgency(company, today);
  if (segment === 'NOW') {
    return urgency === 'overdue' || (company.days_in_stage || 0) >= 14 || company.latest_disposition === 'Callback Requested' || company.latest_disposition === 'Presentation Scheduled';
  }
  if (segment === 'TODAY') {
    return urgency === 'today' || urgency === 'overdue';
  }
  if (segment === 'THIS_WEEK') {
    return true; // All active pipeline accounts
  }
  return true;
}

function renderActionQueue() {
  const container = $('pipelineActionQueue');
  const countBadge = $('actionQueueCount');
  if (!container) return;

  const today = businessDate();
  const filtered = pipelineData.filter((c) => matchesSegment(c, currentSegment, today));

  if (countBadge) {
    countBadge.textContent = `${filtered.length} ${filtered.length === 1 ? 'Task' : 'Tasks'}`;
  }

  if (filtered.length === 0) {
    container.replaceChildren(
      el('div', {
        className: 'empty-state',
        children: [
          el('p', { className: 'muted-note', text: `No accounts currently in the ${currentSegment} queue.` })
        ]
      })
    );
    return;
  }

  container.replaceChildren(
    ...filtered.map((company) => {
      const urgency = getUrgency(company, today);
      const stageClass = company.pipeline_stage === 'CLOSED_WON' ? 'stage-won' : `urgency-${urgency}`;

      let urgencyLabel = '⏳ Active Touch';
      if (urgency === 'overdue') urgencyLabel = `🔥 OVERDUE (${company.next_action_date})`;
      else if (urgency === 'today') urgencyLabel = '⚡ DUE TODAY';
      else if (urgency === 'upcoming') urgencyLabel = `📅 Due ${company.next_action_date}`;
      else if (company.pipeline_stage === 'CLOSED_WON') urgencyLabel = '🏆 Closed Won';

      const nextActionBlock = company.next_action_text
        ? el('div', {
            className: 'action-card-next-action',
            children: [
              el('strong', { text: `🎯 Target Next Step (${urgencyLabel})` }),
              el('span', { text: company.next_action_text })
            ]
          })
        : el('div', {
            className: 'action-card-next-action',
            children: [
              el('strong', { text: `Status: ${urgencyLabel}` }),
              el('span', { text: company.latest_summary || company.latest_disposition || 'No touches recorded yet.' })
            ]
          });

      const metaItems = [
        el('span', { text: `Stage: ${company.pipeline_stage || 'PROSPECT'}` }),
        el('span', { text: `${company.days_in_stage ?? 0}d in stage` }),
        ...(company.industry ? [el('span', { text: company.industry })] : []),
        ...(company.forecast_ap ? [el('span', { className: 'action-card-forecast', text: `$${Number(company.forecast_ap).toLocaleString()} AP` })] : [])
      ];

      // Touch Buttons
      const callBtn = el('button', {
        className: 'action-card-btn',
        attrs: { type: 'button', title: 'Call Decision Maker' },
        children: [el('span', { text: '📞 Call' })]
      });
      callBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showToast(`Account: ${company.company_name} · Stage: ${company.pipeline_stage}`, 'info');
      });

      const logBtn = el('button', {
        className: 'action-card-btn btn-log',
        attrs: { type: 'button', title: 'Open Field Log for this account' },
        children: [el('span', { text: '🚶 Log Touch' })]
      });
      logBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        activateView('field');
        applyCompany(company);
        setBinaryToggles(1, 0, 0); // Pre-fill as In-Person Follow-Up
        showToast(`Pre-filled Field Log for ${company.company_name}`, 'success');
      });

      const snoozeBtn = el('button', {
        className: 'action-card-btn',
        attrs: { type: 'button', title: 'Snooze account follow-up' },
        children: [el('span', { text: '⏰ Snooze' })]
      });
      snoozeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSnoozeModal(company);
      });

      return el('div', {
        className: `action-card ${stageClass}`,
        children: [
          el('div', {
            className: 'action-card-header',
            children: [
              el('div', { className: 'action-card-title', text: company.company_name }),
              el('span', { className: 'action-card-stage-badge', text: company.pipeline_stage || 'PROSPECT' })
            ]
          }),
          el('div', { className: 'action-card-meta', children: metaItems }),
          nextActionBlock,
          el('div', {
            className: 'action-card-actions',
            children: [callBtn, logBtn, snoozeBtn]
          })
        ]
      });
    })
  );
}

function renderKanbanBoard() {
  const STAGES = ['PROSPECT', 'ENGAGED', 'QUALIFIED', 'PROPOSAL', 'CLOSED_WON', 'CLOSED_LOST'];
  let totalAp = 0;

  STAGES.forEach((stage) => {
    const cardsEl = $(`cards-${stage}`);
    const metaEl = $(`meta-${stage}`);
    if (!cardsEl) return;

    const stageCompanies = pipelineData.filter((c) => (c.pipeline_stage || 'PROSPECT') === stage);
    const stageAp = stageCompanies.reduce((sum, c) => sum + (Number(c.forecast_ap) || 0), 0);
    totalAp += stageAp;

    if (metaEl) {
      metaEl.textContent = `${stageCompanies.length} · $${stageAp.toLocaleString()}`;
    }

    if (stageCompanies.length === 0) {
      cardsEl.replaceChildren(
        el('div', { className: 'kanban-empty', text: 'No accounts' })
      );
      return;
    }

    cardsEl.replaceChildren(
      ...stageCompanies.map((company) => {
        const titleEl = el('div', { className: 'kanban-card-title', text: company.company_name });
        const subParts = [
          company.industry,
          `${company.days_in_stage ?? 0}d in stage`,
          company.forecast_ap ? `$${Number(company.forecast_ap).toLocaleString()} AP` : null
        ].filter(Boolean);

        const subEl = el('div', { className: 'kanban-card-sub', text: subParts.join(' · ') });

        const nextActionEl = company.next_action_text
          ? el('div', { className: 'kanban-card-action-text', text: `🎯 ${company.next_action_text}` })
          : null;

        // Stage transition dropdown
        const select = el('select', {
          className: 'kanban-card-stage-select',
          attrs: { 'aria-label': 'Move stage' },
          children: STAGES.map((s) => el('option', {
            text: s.replace('CLOSED_', ''),
            attrs: { value: s, ...(s === stage ? { selected: true } : {}) }
          }))
        });

        select.addEventListener('change', async (e) => {
          const newStage = e.target.value;
          if (newStage === stage) return;
          try {
            await apiPost('/api/pipeline/stage', {
              company_id: company.company_id,
              to_stage: newStage,
              reason: 'Stage moved via Kanban board'
            });
            company.pipeline_stage = newStage;
            showToast(`Moved ${company.company_name} to ${newStage}`, 'success');
            renderPipeline();
          } catch (err) {
            showToast(`Failed to move stage: ${err.message}`, 'error');
            select.value = stage;
          }
        });

        const logBtn = el('button', {
          className: 'btn btn-secondary',
          attrs: { type: 'button', style: 'padding: 0.25rem 0.5rem; font-size: 0.74rem; min-height: 32px;' },
          children: [el('span', { text: '🚶 Log' })]
        });
        logBtn.addEventListener('click', () => {
          activateView('field');
          applyCompany(company);
          setBinaryToggles(1, 0, 0);
        });

        const snoozeBtn = el('button', {
          className: 'btn btn-secondary',
          attrs: { type: 'button', style: 'padding: 0.25rem 0.5rem; font-size: 0.74rem; min-height: 32px;' },
          children: [el('span', { text: '⏰' })]
        });
        snoozeBtn.addEventListener('click', () => openSnoozeModal(company));

        const footer = el('div', {
          className: 'kanban-card-footer',
          children: [select, el('div', { style: 'display: flex; gap: 0.25rem;', children: [logBtn, snoozeBtn] })]
        });

        return el('div', {
          className: 'kanban-card',
          children: [titleEl, subEl, nextActionEl, footer].filter(Boolean)
        });
      })
    );
  });

  const summaryBadge = $('pipelineSummaryBadge');
  if (summaryBadge) {
    summaryBadge.textContent = `Total Pipeline: $${totalAp.toLocaleString()} AP`;
  }
}

export function renderPipeline() {
  renderActionQueue();
  renderKanbanBoard();
}

function openSnoozeModal(company) {
  const dialog = $('snoozeDialog');
  const nameEl = $('snoozeCompanyName');
  const dateInput = $('snoozeUntilDate');
  if (!dialog || !dateInput) return;

  activeSnoozeCompanyId = company.company_id;
  if (nameEl) nameEl.textContent = `Snooze follow-ups for ${company.company_name}:`;

  // Default to 7 days from today
  const defaultDate = new Date();
  defaultDate.setDate(defaultDate.getDate() + 7);
  dateInput.value = defaultDate.toISOString().slice(0, 10);

  dialog.showModal();
}

function initSnoozeDialog() {
  const dialog = $('snoozeDialog');
  const form = $('snoozeForm');
  const cancelBtn = $('btnCancelSnooze');
  const unSnoozeBtn = $('btnUnSnooze');
  if (!dialog || !form) return;

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => dialog.close());
  }

  if (unSnoozeBtn) {
    unSnoozeBtn.addEventListener('click', async () => {
      if (!activeSnoozeCompanyId) return;
      try {
        await apiPost('/api/pipeline/snooze', {
          company_id: activeSnoozeCompanyId,
          until: null
        });
        showToast('Snooze cleared.', 'success');
        dialog.close();
        await fetchPipelineData();
      } catch (err) {
        showToast(`Failed to clear snooze: ${err.message}`, 'error');
      }
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeSnoozeCompanyId) return;
    const until = $('snoozeUntilDate')?.value;
    if (!until) return;

    try {
      await apiPost('/api/pipeline/snooze', {
        company_id: activeSnoozeCompanyId,
        until
      });
      showToast(`Account snoozed until ${until}.`, 'success');
      dialog.close();
      await fetchPipelineData();
    } catch (err) {
      showToast(`Failed to snooze account: ${err.message}`, 'error');
    }
  });
}

export function initPipelineView() {
  // Wire Segmented Control
  document.querySelectorAll('#pipelineSegmentedControl .segment-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#pipelineSegmentedControl .segment-btn').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      currentSegment = btn.dataset.segment;
      renderActionQueue();
    });
  });

  const refreshBtn = $('btnRefreshPipeline');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      setButtonBusy(refreshBtn, true, 'Refreshing…');
      fetchPipelineData().finally(() => setButtonBusy(refreshBtn, false));
    });
  }

  initSnoozeDialog();
  fetchPipelineData();

  window.addEventListener('viewactivated', (e) => {
    if (e.detail?.view === 'pipeline') {
      fetchPipelineData();
    }
  });
}
