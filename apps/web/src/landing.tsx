import { useEffect, useState } from 'react';
import { api } from './api';
import { EnvironmentStatus, Icon } from './app-shell';
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
  const entry = (variant = '') => botUrl
    ? <a className={`landing-cta ${variant}`} href={botUrl}>Открыть в Telegram<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M6 18 18 6M6 6h12v12"/></svg></a>
    : <button className={`landing-cta ${variant}`} disabled={!error} onClick={() => setReload((value) => value + 1)}>{error ? 'Повторить' : 'Подготовка входа…'}</button>;
  return <main className="landing">
    <a className="landing-skip" href="#landing-content">К содержанию</a>
    <EnvironmentStatus/>
    <header className="landing-header landing-wrap">
      <a className="landing-brand" href="#landing-content" aria-label="Таска — к началу"><img src="/brand/tasca-ru-green.svg" width="112" height="31" alt="Таска"/></a>
      <nav className="landing-nav" aria-label="Навигация по лендингу"><a href="#landing-scenarios">Для себя</a><a href="#landing-together">Вдвоём</a><a href="#landing-group">В группе</a>{entry('landing-cta-small')}</nav>
    </header>
    <section className="landing-hero landing-wrap" id="landing-content" tabIndex={-1} aria-labelledby="landing-title">
      <div className="landing-copy"><h1 id="landing-title">Дела — <br/>рядом с <br/><span>перепиской</span></h1><p className="landing-intro">Договорились о чём-то в чате? Добавьте задачу в Таску, чтобы не искать её среди сообщений. У вашей группы будет общая доска: всем понятно, что нужно сделать, кто этим занимается и что уже готово.</p>{entry()}
        {error && <p role="alert">Не удалось подготовить вход. Проверьте связь и нажмите «Повторить».</p>}
      </div>
      <figure className="landing-preview">
        <div className="landing-halo" aria-hidden="true"/>
        <div className="landing-phone" data-device="iphone-17-pro-max">
          <div className="landing-phone-buttons" aria-hidden="true"><i/><i/><i/></div>
          <div className="landing-phone-screen">
            <div className="landing-phone-status" aria-hidden="true"><span>9:41</span><i className="landing-dynamic-island"/><svg viewBox="0 0 50 14"><path d="M1 12V9h3v3Zm5 0V6h3v6Zm5 0V3h3v9Zm5 0V0h3v12Z" fill="currentColor"/><rect x="26" y="2" width="20" height="10" rx="3" fill="none" stroke="currentColor"/><rect x="28" y="4" width="16" height="6" rx="1" fill="currentColor"/><path d="M48 5v4" stroke="currentColor" strokeWidth="2"/></svg></div>
            <img src="/brand/landing-screen.png" width="880" height="1724" alt="Интерфейс Таски в макете iPhone 17 Pro Max: демонстрационные задачи проектов, поездки и личных дел" fetchPriority="high"/>
            <div className="landing-home-indicator" aria-hidden="true"/>
          </div>
        </div>
        <div className="landing-hero-fragment" aria-hidden="true"><img src="/brand/landing-card-project.png" alt=""/></div>
        <div className="landing-hero-fragment landing-hero-fragment-second" aria-hidden="true"><img src="/brand/landing-card-shared.png" alt=""/></div>

      </figure>
    </section>
    <section id="landing-scenarios" className="landing-wrap" aria-label="Для себя, вдвоём и в группе">
      <div className="landing-section-rule" aria-hidden="true"/>
      <div className="landing-scenario-grid">
        <article className="landing-scenario landing-personal">
          <div className="landing-scenario-copy"><h2>Для себя</h2><p>Покупки, планы на неделю и всё, что хочется не забыть. Эти задачи видите только вы.</p></div>
          <div className="landing-personal-visual" aria-hidden="true"><div className="landing-task-fragment landing-task-back"><img src="/brand/landing-card-shared.png" alt="" loading="lazy"/></div><div className="landing-task-fragment"><img src="/brand/landing-card-personal.png" alt="" loading="lazy"/></div></div>
        </article>
        <article id="landing-together" className="landing-scenario landing-pair">
          <div className="landing-scenario-copy"><h2>Вдвоём</h2><p>Спланировать поездку, разобраться с ремонтом или сделать что-то вместе. Поделитесь ссылкой в личной переписке — и ваши общие дела будут под рукой.</p></div>
          <div className="landing-pair-visual" aria-hidden="true"><div className="landing-orbit landing-orbit-one"><Icon name="assignee"/></div><div className="landing-pair-link"><svg viewBox="0 0 24 24"><path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 12a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-1 1" transform="translate(1 -1) scale(.9)"/></svg></div><div className="landing-orbit landing-orbit-two"><Icon name="assignee"/></div></div>
        </article>
        <article id="landing-group" className="landing-scenario landing-group">
          <div className="landing-scenario-copy"><h2>В группе</h2><p>Обсуждайте дела в привычном чате, а задачи собирайте на общей доске. Договорённости, сроки и результаты — в одном месте.</p></div>
          <div className="landing-group-visual" aria-hidden="true"><div className="landing-app-window"><img src="/brand/landing-screen.png" width="880" height="1724" alt="" loading="lazy"/></div><div className="landing-group-fragment"><img src="/brand/landing-card-project.png" alt="" loading="lazy"/></div></div>
        </article>
      </div>
    </section>
    <section className="landing-start landing-wrap" aria-labelledby="landing-start-title">
      <div><h2 id="landing-start-title">Начать просто</h2><div className="landing-start-art" aria-hidden="true">
        <div className="landing-start-message"><Icon name="send"/><span>Давайте начнём с плана</span></div>
        <svg className="landing-start-trail" viewBox="0 0 320 160" fill="none"><path d="M245 8c95 90-220 2-180 135" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 7"/><path d="m57 133 8 12 10-10" stroke="currentColor" strokeWidth="1.5"/></svg>
        <div className="landing-start-task"><img src="/brand/landing-card-project.png" alt="" loading="lazy"/></div>
        <div className="landing-start-done"><Icon name="tasks"/></div>
      </div></div>
      <div><ol>
        <li><span className="landing-step-number" aria-hidden="true">1</span><div><h3>Откройте бота</h3><p>Перейдите в Telegram и нажмите «Запустить».</p></div></li>
        <li><span className="landing-step-number" aria-hidden="true">2</span><div><h3>Выберите, с кем будете вести дела</h3><p>Для себя — личная доска. Для двоих — приглашение по ссылке. Для группы — добавьте бота в чат: администратор запустит общую доску, а сообщение с кнопкой можно закрепить.</p></div></li>
        <li><span className="landing-step-number" aria-hidden="true">3</span><div><h3>Добавьте первую задачу</h3><p>Запишите, что нужно сделать. Исполнителя и срок можно указать сразу или добавить позже.</p></div></li>
      </ol><details><summary>Telegram не открылся?</summary><p>Для работы нужен Telegram. Установите приложение или войдите в его веб-версию, затем откройте ссылку ещё раз.</p>{botUrl && <p>Можно найти бота в Telegram: <a href={botUrl}>@{new URL(botUrl).pathname.slice(1)}</a>.</p>}</details></div>
    </section>
    <section className="landing-final-shell" aria-labelledby="landing-final-title"><div className="landing-final"><h2 id="landing-final-title">Пусть договорённости становятся делами</h2><p>Для себя, вдвоём или всей группой — начните с одной задачи.</p>{entry('landing-cta-light')}</div></section>
    <footer className="landing-footer landing-wrap"><img src="/brand/tasca-ru-green.svg" width="80" height="22" alt=""/><span>Создано kAIros</span></footer>
  </main>;
}
