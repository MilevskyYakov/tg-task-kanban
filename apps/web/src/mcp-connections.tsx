import { useEffect, useRef, useState } from 'react';
import { api, ApiError, json } from './api';
import { ActionRow, AppShell, ChoiceRow, Icon, IconButton, SettingsScreen, Sheet, Skeleton } from './app-shell';
import { boardTypeName, type Board } from './domain';
import { useTelegramEnvironment } from './environment';
import type { NavigationState } from './navigation';
import './mcp-connections.css';

type Connection = {id: string; name: string; mode: 'read'|'write'; createdAt: string; revokedAt: string|null; boards: Pick<Board, 'id'|'name'|'status'>[]; lostBoardCount: number};
type Draft = {requestId: string; name: string; mode: 'read'|'write'; boardIds: string[]};
type Listing = {items: Connection[]; nextCursor: string|null; serverUrl: string};
const accessLabel = (mode: Connection['mode']) => mode === 'read' ? 'Только чтение' : 'Чтение и изменение';
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  try { return await api<T>('/api/mcp-connections'+path, {...init, cache:'no-store', signal:controller.signal}); }
  finally { window.clearTimeout(timer); }
}

export function McpConnections({navigate}: {navigate: (next: NavigationState) => void}) {
  const online = useTelegramEnvironment();
  const [stage, setStage] = useState<'list'|'create'|'secret'|'details'|'lost'>('list');
  const [listing, setListing] = useState<Listing>();
  const [selected, setSelected] = useState<Connection>();
  const [secret, setSecret] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<Connection['mode']>('read');
  const [boardIds, setBoardIds] = useState<string[]>([]);
  const [boards, setBoards] = useState<Board[]>();
  const [boardDraft, setBoardDraft] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<'boards'|'leave'|'revoke'|'help'>();
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const busy = useRef(false);
  const submitted = useRef<Draft | undefined>(undefined);
  const listRequest = useRef(0);
  const invalidSession = (error: unknown) => {
    if (!(error instanceof ApiError) || error.status !== 401) return false;
    setSecret(''); setSelected(undefined); setDialog(undefined); setExpired(true); return true;
  };
  const load = async (more = false) => {
    const serial = ++listRequest.current;
    setLoading(true); setError('');
    try {
      const result = await request<Listing>(more && listing?.nextCursor ? '?cursor='+encodeURIComponent(listing.nextCursor) : '');
      if (serial !== listRequest.current) return;
      setListing(previous => ({...result, items: more ? [...(previous?.items ?? []), ...result.items] : result.items}));
      setServerUrl(result.serverUrl);
    } catch (error) { if (serial === listRequest.current && !invalidSession(error)) setError('Не удалось загрузить подключения.'); }
    finally { if (serial === listRequest.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { ++listRequest.current; }; }, []);
  useEffect(() => {
    const clear = () => { setSecret(''); setCopied(false); if (stage === 'secret') setStage('details'); };
    window.addEventListener('pagehide',clear);
    return () => window.removeEventListener('pagehide',clear);
  }, [stage]);
  useEffect(() => {
    if (!secret || !selected) return;
    const check = () => { if (document.visibilityState === 'visible') void request<Connection>('/'+selected.id).then(value => { if (value.revokedAt) { setSecret(''); setSelected(value); setStage('details'); } }).catch(invalidSession); };
    document.addEventListener('visibilitychange',check);
    return () => document.removeEventListener('visibilitychange',check);
  }, [secret,selected?.id]);
  const backToList = () => { setSecret(''); setCopied(false); setUncertain(false); submitted.current=undefined; setDialog(undefined); setError(''); setMessage(''); setStage('list'); void load(); };
  const back = () => {
    if (busy.current) return;
    if ((stage === 'secret' && !copied) || (stage === 'create' && (name || boardIds.length || uncertain))) { setDialog('leave'); return; }
    if (stage === 'list') navigate({screen:'settings-account'}); else backToList();
  };
  const loadBoards = async () => {
    setBoards(undefined);
    try { setBoards((await api<{boards:Board[]}>('/api/boards',{cache:'no-store'})).boards); }
    catch (error) { if (!invalidSession(error)) setError('Не удалось загрузить доски. Попробуйте ещё раз.'); }
  };
  const start = () => {
    if (busy.current || !online) return;
    setStage('create'); setName(''); setMode('read'); setBoardIds([]); setSecret(''); setError(''); setMessage(''); setUncertain(false); submitted.current=undefined;
    void loadBoards();
  };
  const open = async (id: string) => {
    if (busy.current) return;
    busy.current=true; setLoading(true); setError('');
    try { setSelected(await request<Connection>('/'+id)); setStage('details'); }
    catch (error) { if (!invalidSession(error)) setError('Не удалось загрузить подключение. Проверьте доступ и повторите.'); }
    finally { busy.current=false; setLoading(false); }
  };
  const create = async () => {
    if (busy.current || !online) return;
    const payload = submitted.current ?? {requestId:crypto.randomUUID(),name:name.trim(),mode,boardIds};
    submitted.current=payload; busy.current=true; setPending(true); setError(''); setMessage('');
    try {
      const result = await request<{connection:Connection;key:string;serverUrl:string}>('',json('POST',payload));
      setSelected(result.connection); setSecret(result.key); setServerUrl(result.serverUrl); setCopied(false); setUncertain(false); setStage('secret'); submitted.current=undefined;
    } catch (error) {
      if (invalidSession(error)) return;
      if (error instanceof ApiError && error.data.code === 'KEY_ALREADY_ISSUED') {
        setSelected(error.data.connection as Connection); setStage('lost'); setSecret(''); setUncertain(false);
      } else if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        setUncertain(false); submitted.current=undefined; setError(error.message);
        if (error.status === 404) void loadBoards();
      } else { setUncertain(true); setError('Не удалось получить результат. Ключ мог быть создан.'); }
    } finally { busy.current=false; setPending(false); }
  };
  const revoke = async () => {
    if (!selected || busy.current || !online) return;
    busy.current=true; setPending(true); setError('');
    try {
      await request('/'+selected.id,json('DELETE',{}));
      const result = await request<Connection>('/'+selected.id);
      if (!result.revokedAt) throw new Error('revoke not confirmed');
      setSelected(result); setSecret(''); submitted.current=undefined; setDialog(undefined); setStage('details'); setMessage('Доступ отозван');
    } catch (error) { if (!invalidSession(error)) setError('Не удалось подтвердить отзыв. Подключение может оставаться активным. Проверьте ещё раз.'); }
    finally { busy.current=false; setPending(false); }
  };
  const copy = async (value: string, key = false) => {
    setMessage(''); setError('');
    try { await navigator.clipboard.writeText(value); if (key) setCopied(true); setMessage(key ? 'Ключ скопирован' : 'Адрес скопирован'); }
    catch { setError(`Не удалось скопировать. Выделите ${key ? 'ключ' : 'адрес'} и скопируйте вручную.`); }
  };
  const isolated = ['create','secret','lost'].includes(stage);
  const title = stage === 'create' ? 'Новое подключение' : stage === 'secret' ? 'Ключ создан' : stage === 'lost' ? 'Ключ не получен' : stage === 'details' ? selected?.name ?? 'Подключение' : 'Подключения';
  const summary = selected && <div className="mcp-summary"><strong>{selected.name}</strong><p>{accessLabel(selected.mode)}<br/>{selected.boards.map(board=>board.name).join(' · ') || 'Нет доступных досок'}</p>{selected.lostBoardCount > 0 && <p>Доступ к одной из выбранных досок потерян.</p>}</div>;
  const address = <div className="mcp-address"><p className="mcp-label">Адрес MCP-сервера</p><p className="mcp-code" tabIndex={0}>{serverUrl}</p><button className="secondary" onClick={()=>void copy(serverUrl)}>Копировать адрес</button></div>;
  const body = <>
    {!isolated && <button className="back settings-back" onClick={back}><Icon name="back"/>{stage === 'list' ? 'Аккаунт' : 'Подключения'}</button>}
    {!online && <p role="status">Нет соединения. Изменения доступа недоступны.</p>}
    {error && <p className="mcp-feedback" role="alert">{error}</p>}
    {message && <p className="mcp-feedback" role="status">{message}</p>}
    {stage === 'list' && <>
      {loading ? <Skeleton label="Загружаем подключения…"/> : error ? <button onClick={()=>void load()}>Повторить</button> : <>
        {!listing?.items.length ? <div className="mcp-empty"><h2>Ваши задачи.<br/>В вашем AI-клиенте.</h2><p>Подключите Hermes или другой MCP-клиент. Вы сами выбираете доски и разрешённые действия.</p><p>Подключений пока нет</p></div> : <div className="mcp-list">{listing.items.map(item=><ActionRow key={item.id} label={item.name} value={<>{item.revokedAt ? 'Доступ отозван' : accessLabel(item.mode)}<small>{item.boards.map(board=>board.name).join(' · ') || 'Нет доступных досок'}{item.lostBoardCount > 0 && ' · Доступ к доске потерян'}</small></>} onClick={()=>void open(item.id)}/>)}</div>}
        {listing?.nextCursor && <button className="secondary" onClick={()=>void load(true)}>Показать ещё</button>}
        <button className="mcp-primary" disabled={!online} onClick={start}>Добавить подключение</button>
      </>}
    </>}
    {stage === 'create' && <form className="mcp-create" onSubmit={event=>{event.preventDefault();void create();}}>
      <fieldset className="readonly-fields" disabled={pending || uncertain || !online}>
        <label className="mcp-name">Название<input autoFocus value={name} onChange={event=>setName(event.target.value)} placeholder="Мой Hermes" autoComplete="off" maxLength={80} required/></label>
        <ActionRow label="Доски" value={boardIds.length ? boards?.filter(board=>boardIds.includes(board.id)).map(board=>board.name).join(', ') || 'Проверьте выбор досок' : 'Выберите доски'} onClick={()=>{setBoardDraft([...boardIds]);setQuery('');setDialog('boards');}}/>
        <div className="mcp-modes" role="radiogroup" aria-label="Разрешённые действия"><ChoiceRow label="Только чтение" detail="Просмотр и поиск задач" selected={mode==='read'} onClick={()=>setMode('read')}/><ChoiceRow label="Чтение и изменение" detail="Создание, назначение, сроки и статусы" selected={mode==='write'} onClick={()=>setMode('write')}/></div>
        <p>Только ваши права. Новые доски не добавляются автоматически.</p><p>Без срока действия. Отключить доступ можно в любой момент.</p>
      </fieldset>
      {uncertain && <p>Сначала проверим подключение, чтобы не создать лишний доступ. Повтор использует тот же запрос.</p>}
      {!uncertain && (!name.trim() || !boardIds.length) && <p className="mcp-hint">Укажите название и выберите хотя бы одну доску.</p>}
      <button className="mcp-primary" disabled={pending || !online || (!uncertain && (!name.trim() || !boardIds.length))}>{pending ? 'Создаём ключ…' : uncertain ? 'Проверить результат' : 'Создать ключ'}</button>
    </form>}
    {stage === 'secret' && <div className="mcp-secret">{summary}<h2>Сохраните ключ сейчас</h2><p>После выхода повторный показ недоступен. Вставьте ключ в настройки клиента, не в переписку с агентом.</p>{address}<p className="mcp-label">Ключ доступа</p><p className="mcp-code mcp-key" tabIndex={0}>{secret}</p><p>Ключ действует до отзыва. При утечке отзовите подключение.</p><button className="mcp-help back" onClick={()=>setDialog('help')}>Как подключить Hermes</button><div className="mcp-actions"><button onClick={()=>void copy(secret,true)}>{copied ? 'Ключ скопирован' : 'Копировать ключ'}</button><button className="secondary" onClick={back}>Готово</button></div></div>}
    {stage === 'lost' && <>{summary}<h2>Ключ создан, но не был получен</h2><p>Показать его повторно невозможно. Отзовите это подключение перед созданием нового.</p><button className="danger mcp-primary" disabled={!online} onClick={()=>{setError('');setDialog('revoke');}}>Отозвать доступ</button></>}
    {stage === 'details' && selected && <div className="mcp-details">{summary}{selected.revokedAt ? <><p>Доступ отозван</p><button className="mcp-primary" disabled={!online} onClick={start}>Создать новое подключение</button></> : <>
      <h2>Доступ</h2><p>{accessLabel(selected.mode)}</p><h2>Доски</h2>{selected.boards.length ? <ul>{selected.boards.map(board=><li key={board.id}>{board.name}{board.status!=='active' && ' — только чтение: доска неактивна'}</li>)}</ul> : <p>Это подключение больше не даёт доступа к задачам. Его можно отозвать.</p>}<h2>Срок действия</h2><p>До ручного отзыва</p>{address}<p>Ключ скрыт. Повторный показ недоступен.</p><p>Чтобы изменить доступ или заменить потерянный ключ, отзовите это подключение и создайте новое.</p><button className="danger mcp-primary" disabled={!online} onClick={()=>{setError('');setDialog('revoke');}}>Отозвать доступ</button>
    </>}</div>}
  </>;
  return <AppShell message="" navigation={{screen:'settings-connections'}} navigate={navigate} hideNavigation={isolated || expired}>
    <div className="mcp-screen">{expired ? <SettingsScreen title="Войдите снова через Telegram"><p>Сессия закончилась. Закройте приложение и откройте его через бота.</p></SettingsScreen> : isolated ? <section className="mcp-form-screen"><header><IconButton label="Назад" disabled={pending} onClick={back}><Icon name="back"/></IconButton><h1>{title}</h1></header>{body}</section> : <SettingsScreen title={title}>{body}</SettingsScreen>}</div>
    {!expired && dialog === 'boards' && <Sheet title="Доступные доски" onClose={()=>setDialog(undefined)}><div className="mcp-sheet"><label>Найти доску<input value={query} onChange={event=>setQuery(event.target.value)}/></label>{!boards ? <><p>Доски не загружены</p><button onClick={()=>void loadBoards()}>Повторить загрузку</button></> : <div>{boards.filter(board=>board.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(board=><ChoiceRow key={board.id} kind="check" label={board.name} detail={board.status==='active' ? boardTypeName(board) : 'Только чтение: доска неактивна'} selected={boardDraft.includes(board.id)} onClick={()=>setBoardDraft(ids=>ids.includes(board.id) ? ids.filter(id=>id!==board.id) : [...ids,board.id])}/>)}</div>}<button disabled={!boards} onClick={()=>{setBoardIds(boardDraft.filter(id=>boards?.some(board=>board.id===id)));setDialog(undefined);}}>Готово</button></div></Sheet>}
    {!expired && dialog === 'leave' && <Sheet title={stage==='secret' ? 'Закрыть без сохранения ключа?' : uncertain ? 'Выйти без проверки результата?' : 'Выйти без сохранения?'} onClose={()=>setDialog(undefined)}><div className="mcp-sheet"><p>{stage==='secret' ? 'Показать его ещё раз не получится. Подключение останется активным до отзыва.' : uncertain ? 'Ключ мог быть создан. Проверьте список подключений и отзовите доступ, если ключ потерян.' : 'Название и выбор досок не сохранятся.'}</p><button onClick={()=>setDialog(undefined)}>Остаться</button><button className="secondary" onClick={backToList}>Закрыть</button></div></Sheet>}
    {!expired && dialog === 'revoke' && selected && <Sheet title="Отозвать доступ?" onClose={()=>{if (!busy.current) setDialog(undefined);}}><div className="mcp-sheet"><p>{selected.name} больше не сможет читать и изменять задачи. Сами задачи останутся. Для нового подключения понадобится новый ключ.</p><p>Уже сохранённые изменения и ранее прочитанные данные не отменяются.</p>{error && <p role="alert">{error}</p>}<button className="danger" disabled={pending || !online} onClick={()=>void revoke()}>{pending ? 'Отзываем доступ…' : error ? 'Проверить ещё раз' : 'Отозвать доступ'}</button><button className="secondary" disabled={pending} onClick={()=>setDialog(undefined)}>Отмена</button></div></Sheet>}
    {!expired && dialog === 'help' && <Sheet title="Как подключить Hermes" onClose={()=>setDialog(undefined)}><div className="mcp-sheet"><p>В настройках MCP Hermes добавьте адрес сервера. Для Authorization укажите Bearer и ключ из этого экрана. Храните ключ в настройках секретов клиента, не в чате.</p><p>Подключение использует Streamable HTTP без OAuth. Ключ действует до ручного отзыва.</p><a href="https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp" target="_blank" rel="noopener noreferrer">Инструкция Hermes</a><button onClick={()=>setDialog(undefined)}>Готово</button></div></Sheet>}
  </AppShell>;
}
