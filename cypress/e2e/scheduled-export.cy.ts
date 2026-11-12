/**
 * Scheduled export, end to end: set up a schedule in the dialog, let it run,
 * and check each run's zip. Discord is faked with a message store the test
 * changes between runs (new messages, a wipe, a channel that answers 403).
 *
 * The scheduler sleeps on a worker timer, which cy.clock cannot move, so
 * the test makes the next run due by setting the stored schedule's
 * `nextRunAt` to 0; the scheduler's next 15 second check picks it up.
 */

const API = '**/api/v10';
const NO_STORE = { 'cache-control': 'no-store' };
const DISCORD_EPOCH = 1420070400000n;
const GENERAL = '801000000000000001';
const DEV_CHAT = '801000000000000002';
const ZIP = /^discrub-schedule_cypress_test_server_.*\.zip$/;
const RUN_TIMEOUT = 90_000;

type FakeMessage = Record<string, unknown> & { id: string; channel_id: string; content: string };

/** A snowflake for `ms`, plus `n` so ids in one millisecond differ. */
const snowflakeAt = (ms: number, n = 0): string => (((BigInt(ms) - DISCORD_EPOCH) << 22n) + BigInt(n)).toString();

describe('Scheduled export', () => {
  /** Messages per channel, oldest first. The intercept serves `after` pages from here. */
  let store: Record<string, FakeMessage[]>;
  let template: Record<string, unknown>;
  let failing: Set<string>;

  const message = (channelId: string, id: string, content: string): FakeMessage => ({
    ...template,
    id,
    channel_id: channelId,
    content,
    timestamp: new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH)).toISOString(),
  });

  /** Makes every stored schedule due now. */
  const makeDue = () =>
    cy.window().then((win) => new Cypress.Promise<void>((resolve, reject) => {
      const open = win.indexedDB.open('Discrub-schedules');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('keyval', 'readwrite');
        const keyval = tx.objectStore('keyval');
        const cursor = keyval.openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          c.update({ ...c.value, nextRunAt: 0 });
          c.continue();
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    }));

  const readZip = (zipName: string, entry: string) =>
    cy.task<string>('zip:read', { fileName: zipName, entry }).then((text) => JSON.parse(text));

  const openSchedulesList = () => {
    cy.get('[aria-label="More options"]').first().click();
    cy.get('[data-testid="more-menu-schedules"]').click();
    cy.get('[data-testid="schedules-dialog"]').should('be.visible');
  };

  beforeEach(() => {
    store = {};
    failing = new Set();
    cy.task('downloads:clean');
    cy.fixture('messages.json').then((messages) => {
      template = messages[0];
    });
    cy.login();

    // After login, so these win over the shared fixtures (last registered wins).
    cy.intercept('GET', `${API}/channels/*/messages?*`, (req) => {
      const channelId = new URL(req.url).pathname.split('/').at(-2)!;
      const after = new URL(req.url).searchParams.get('after');
      if (failing.has(channelId)) {
        req.reply({ statusCode: 403, headers: NO_STORE, body: { message: 'Missing Access', code: 50001 } });
        return;
      }
      const all = store[channelId] ?? [];
      // Only the scheduler pages with `after`; the feed's own loads get an empty channel.
      const page = after === null
        ? []
        : all.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, 100).reverse();
      req.reply({ statusCode: 200, headers: NO_STORE, body: page });
    }).as('scheduledMessages');
    cy.intercept('GET', `${API}/guilds/*/threads/active`, { statusCode: 200, headers: NO_STORE, body: { threads: [], members: [] } });
    cy.intercept('GET', `${API}/channels/*/threads/archived/public*`, { statusCode: 200, headers: NO_STORE, body: { threads: [], has_more: false } });
    cy.intercept('GET', `${API}/channels/*/threads/archived/private*`, { statusCode: 403, headers: NO_STORE, body: { message: 'Missing Permissions', code: 50013 } });
    cy.intercept('GET', `${API}/channels/*/users/@me/threads/archived/private*`, { statusCode: 200, headers: NO_STORE, body: { threads: [], has_more: false } });

    cy.selectServer('Cypress Test Server');
    cy.contains('general').should('be.visible');
  });

  const createSchedule = () => {
    cy.get('[aria-label="Toggle multi-select"]').first().click();
    cy.contains('general').click();
    cy.contains('dev-chat').click();
    cy.get('[data-testid="multi-select-schedule"]').first().click();
    cy.get('[data-testid="schedule-export-dialog"]').should('be.visible');

    // general from its full history, dev-chat from now on.
    cy.get(`[data-testid="schedule-start-${GENERAL}"]`).click();
    cy.get('[role="listbox"]').contains('Full history').click();
    cy.get(`[data-testid="schedule-start-${DEV_CHAT}"]`).should('contain.text', 'From now on');
    cy.get('[data-testid="schedule-name"]').should('have.value', 'Cypress Test Server');
    cy.screenshot('scheduled-export-dialog', { capture: 'viewport' });

    cy.get('[data-testid="schedule-create"]').click();
    cy.contains('Scheduled export Cypress Test Server created').should('be.visible');
  };

  it('exports a full-history channel, then only new messages, through a wipe', () => {
    // Before the schedule: three old messages in general, one in dev-chat.
    const old = Date.now() - 24 * 60 * 60 * 1000;
    store[GENERAL] = [1, 2, 3].map((n) => message(GENERAL, snowflakeAt(old, n), `old general ${n}`));
    store[DEV_CHAT] = [message(DEV_CHAT, snowflakeAt(old, 9), 'old dev-chat, before the schedule')];

    createSchedule();

    // Run 1: general's history; dev-chat's old message is before "from now on".
    cy.waitForDownload(ZIP, RUN_TIMEOUT).then((zipName) => {
      readZip(zipName, 'manifest.json').then((manifest) => {
        expect(manifest.format).to.eq('discrub-scheduled-export');
        expect(manifest.run.number).to.eq(1);
        expect(manifest.schedule.scope).to.deep.eq({ kind: 'guild', guildId: '901000000000000001', guildName: 'Cypress Test Server' });
        expect(manifest.channels.map((c: { id: string; messages: number }) => [c.id, c.messages])).to.deep.eq([[GENERAL, 3]]);
        expect(manifest.skipped).to.deep.eq([]);
      });
      readZip(zipName, `general_${GENERAL}/messages-0001.json`).then((messages) => {
        expect(messages.map((m: FakeMessage) => m.content)).to.deep.eq(['old general 1', 'old general 2', 'old general 3']);
      });
      cy.task<{ name: string }[]>('zip:list', zipName).then((entries) => {
        expect(entries.some((e) => e.name.startsWith(`dev_chat_${DEV_CHAT}/`))).to.eq(false);
      });
    });

    // A bot wipes general, then new messages arrive in both channels.
    cy.then(() => {
      const now = Date.now();
      store[GENERAL] = [message(GENERAL, snowflakeAt(now, 1), 'new general after the wipe')];
      store[DEV_CHAT].push(message(DEV_CHAT, snowflakeAt(now, 2), 'new dev-chat'));
    });
    cy.task('downloads:clean');
    makeDue();

    // Run 2: only the new messages.
    cy.waitForDownload(ZIP, RUN_TIMEOUT).then((zipName) => {
      readZip(zipName, 'manifest.json').then((manifest) => {
        expect(manifest.run.number).to.eq(2);
        expect(manifest.channels.map((c: { id: string; messages: number }) => [c.id, c.messages])).to.deep.eq([[GENERAL, 1], [DEV_CHAT, 1]]);
      });
      readZip(zipName, `general_${GENERAL}/messages-0001.json`).then((messages) => {
        expect(messages.map((m: FakeMessage) => m.content)).to.deep.eq(['new general after the wipe']);
      });
      readZip(zipName, `dev_chat_${DEV_CHAT}/messages-0001.json`).then((messages) => {
        expect(messages.map((m: FakeMessage) => m.content)).to.deep.eq(['new dev-chat']);
      });
    });

    // Run 3: nothing new, so no download, and the list says so.
    cy.task('downloads:clean');
    makeDue();
    openSchedulesList();
    cy.get('[data-testid="schedule-last-run"]', { timeout: RUN_TIMEOUT }).should('contain.text', 'nothing new');
    cy.screenshot('scheduled-exports-list', { capture: 'viewport' });
    cy.task<{ name: string }[]>('downloads:list').then((files) => {
      expect(files.filter((f) => ZIP.test(f.name))).to.have.length(0);
    });
  });

  it('skips a channel that fails and keeps exporting the rest', () => {
    const now = Date.now();
    createSchedule();
    cy.then(() => {
      failing.add(DEV_CHAT);
      store[GENERAL] = [message(GENERAL, snowflakeAt(now + 60_000, 1), 'general while dev-chat fails')];
    });

    cy.waitForDownload(ZIP, RUN_TIMEOUT).then((zipName) => {
      readZip(zipName, 'manifest.json').then((manifest) => {
        expect(manifest.channels.map((c: { id: string }) => c.id)).to.deep.eq([GENERAL]);
        expect(manifest.skipped).to.deep.eq([{ id: DEV_CHAT, name: 'dev-chat', reason: '403' }]);
      });
    });

    openSchedulesList();
    cy.get('[data-testid="schedule-last-run"]').should('contain.text', '1 skipped');
    cy.get('[data-testid="schedule-status"]').should('contain.text', 'Running');
  });

  it('stops and deletes a schedule from the list', () => {
    createSchedule();
    openSchedulesList();
    // Let the first run finish before stopping, so the stop is the schedule's, not a run's cancel.
    cy.get('[data-testid="schedule-last-run"]', { timeout: RUN_TIMEOUT }).should('not.contain.text', 'Not run yet');
    cy.get('[data-testid="schedule-stop"]').click();
    cy.get('[data-testid="schedule-status"]').should('contain.text', 'Stopped');
    cy.get('[data-testid="schedule-resume"]').should('be.visible');
    cy.get('[data-testid="schedule-delete"]').click();
    cy.get('[data-testid="schedule-delete-yes"]').click();
    cy.get('[data-testid="schedule-list-empty"]').should('be.visible');
  });
});
