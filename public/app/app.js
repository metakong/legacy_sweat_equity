/**
 * Entry point for the Aflac field prospecting PWA.
 *
 * Two form factors, one bundle:
 *   S21+ / Moto G   the field log view is the whole app
 *   Book Go 5G      a sidebar reveals the route planner and the D365 tabs
 *
 * Nothing here is framework-bound and there is no build step — these are
 * native ES modules served straight from ./public.
 */

import { initViewSwitcher, activateView, onViewOpen, isDesktop, apiFetch, apiPost } from './ui.js';
import { initStore, initConnectivityWatch, onSynced } from './store.js';
import { initFieldView } from './field.js';
import { initDesktopViews, refreshActiveDesktopView } from './desktop.js';
import { initPipelineView, fetchPipelineData } from './pipeline.js';

export { apiFetch, apiPost };

// Offline capability. Registration failure is not fatal — the app still runs,
// it just will not survive a cold start without a network.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .catch((err) => console.error('Service Worker registration failed', err));
}

initStore();
initConnectivityWatch();
initViewSwitcher();
initFieldView();
initDesktopViews();
onViewOpen('pipeline', initPipelineView);

// Land on the field log on every device. On mobile the sidebar is hidden by
// CSS, so this is the only reachable view.
activateView('field');

// A queue drain can change what the active tables should show.
onSynced(() => {
  refreshActiveDesktopView();
  fetchPipelineData();
});
