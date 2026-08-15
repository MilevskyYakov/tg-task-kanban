import { useState } from 'react';
import { ActionRow, AppShell, ChoiceSheet, Disclosure, TaskGlyph } from './app-shell';
import type { NavigationState } from './navigation';

const options = ['Все доски', 'Kairos', 'Личные задачи'];

export function FoundationFixture() {
  const [navigation, setNavigation] = useState<NavigationState>({ screen: 'tasks' });
  const [choice, setChoice] = useState('Kairos');
  const [sheetOpen, setSheetOpen] = useState(() => new URLSearchParams(location.search).get('sheet') === '1');

  window.Telegram = {
    WebApp: {
      initData: 'visual-fixture',
      colorScheme: 'dark',
      ready() {},
      expand() {}
    }
  };

  return <AppShell message="" navigation={navigation} navigate={setNavigation}>
    <section className="foundation-fixture" aria-label="Visual foundation fixture">
      <header className="fixture-header"><div><p className="eyebrow">VISUAL FOUNDATION V2</p><h1>Редакционная<br/>основа</h1></div><TaskGlyph/></header>
      <p>Детерминированная Telegram fixture: dark scheme передан, интерфейс остаётся светлым.</p>
      <div className="fixture-fields">
        <ActionRow label="Доска" value={choice} icon={<span aria-hidden="true">01</span>} onClick={() => setSheetOpen(true)}/>
        <ActionRow label="Исполнитель" value="Яков" icon={<span aria-hidden="true">02</span>} onClick={() => setSheetOpen(true)}/>
        <fieldset className="deadline-fields"><legend>Срок</legend><input aria-label="Дата срока" type="date" defaultValue="2026-08-21"/><input aria-label="Время срока" type="time" defaultValue="18:30"/></fieldset>
      </div>
      <Disclosure label="Дополнительно"><p>Disclosure использует общий chevron, 44 px target и явный `aria-expanded`.</p></Disclosure>
      <p className="fixture-meta">390 / 320 · NEWSREADER / INTER / IBM PLEX MONO</p>
    </section>
    {sheetOpen && <ChoiceSheet title="Выберите доску" onClose={() => setSheetOpen(false)}><div className="sheet-options">{options.map((option) => <button className={choice === option ? 'selected' : ''} key={option} onClick={() => { setChoice(option); setSheetOpen(false); }}><span>{option}</span><small>{choice === option ? 'Выбрано' : 'Доступно'}</small></button>)}</div></ChoiceSheet>}
  </AppShell>;
}
