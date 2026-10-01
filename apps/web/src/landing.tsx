import { useEffect, useState } from 'react';
import { api } from './api';
import { EnvironmentStatus } from './app-shell';
import './landing.css';

export function Landing() {
  const [botUrl, setBotUrl] = useState('');
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(false);
    void api<{botUrl: string}>('/api/bot-entry').then((data) => {
      if (!/^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\?start=landing$/.test(data.botUrl)) throw new Error('Invalid bot entry');
      if (!cancelled) setBotUrl(data.botUrl);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [reload]);
  const entry = (compact = false) => botUrl
    ? <a className={`landing-cta${compact ? ' landing-cta-quiet' : ''}`} href={botUrl}>{compact ? 'Открыть' : 'Открыть в Telegram'}<span aria-hidden="true">↗</span></a>
    : <button className={`landing-cta${compact ? ' landing-cta-quiet' : ''}`} disabled={!error} onClick={() => setReload((value) => value + 1)}>{error ? 'Повторить' : 'Подготовка входа…'}</button>;
  return <main className="landing">
    <a className="landing-skip" href="#landing-content">К содержанию</a>
    <EnvironmentStatus/>
    <header className="landing-header"><img src="/brand/tasca-ru-green.svg" width="108" height="36" alt="Таска"/>{entry(true)}</header>
    <section className="landing-hero" id="landing-content" aria-labelledby="landing-title">
      <div className="landing-copy"><p className="landing-label">Задачник в Telegram</p><h1 id="landing-title">Дела<br/>под рукой</h1><p className="landing-intro">Задачи для себя и команды — прямо в Telegram.</p>{entry()}
        {error && <p role="alert">Не удалось подготовить вход. Проверьте связь и нажмите «Повторить».</p>}
      </div>
      <figure className="landing-preview"><img src="/brand/app-preview.webp" width="390" height="844" alt="Список задач в Таске: исполнители, сроки, статусы и переход к созданию задачи" fetchPriority="high"/><figcaption>Один список для личных и общих дел</figcaption></figure>
    </section>
    <section className="landing-scenarios" aria-labelledby="landing-scenarios-title"><h2 id="landing-scenarios-title">Для себя, вдвоём или командой</h2><div className="landing-columns">
      <article><h3>Личные дела</h3><p>Запишите задачу, добавьте срок, если он нужен. Личную доску видите только вы.</p></article>
      <article><h3>Планы на двоих</h3><p>Создайте общую доску и пригласите человека по ссылке. Отдельная группа не нужна.</p></article>
      <article><h3>Задачи команды</h3><p>Добавьте бота в группу. Администратор запустит доску, а закреплённое сообщение станет общим входом.</p></article>
    </div></section>
    <section className="landing-start" aria-labelledby="landing-start-title"><h2 id="landing-start-title">Начните с одной задачи</h2><ol><li>Откройте бота в Telegram и нажмите «Запустить».</li><li>Выберите личные задачи, доску на двоих или группу.</li><li>Создайте задачу. Исполнителя и срок можно добавить позже.</li></ol>{entry()}
      <details><summary>Telegram не открылся?</summary><p>Для работы нужен Telegram. Установите приложение или войдите в его веб-версию, затем откройте ссылку ещё раз. Кнопка ведёт в бота, а не подтверждает вход.</p>{botUrl && <p>Можно найти бота в Telegram: <a href={botUrl}>@{new URL(botUrl).pathname.slice(1)}</a>.</p>}</details>
    </section>
    <footer className="landing-footer">Создано kAIros</footer>
  </main>;
}
