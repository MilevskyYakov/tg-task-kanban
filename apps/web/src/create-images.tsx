import { useEffect, useRef, useState } from 'react';
import { api, imageUpload } from './api';
import type { Collaboration } from './domain';

export type DraftImage = { id: string; file: File };
const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function draftImages(files: File[]): DraftImage[] {
  for (const file of files) {
    if (!imageTypes.includes(file.type)) throw new Error('Поддерживаются только изображения PNG, JPEG, WebP и GIF');
    if (!file.size) throw new Error('Пустое изображение нельзя прикрепить');
    if (file.size > 15 * 1024 * 1024) throw new Error('Файл больше 15 МБ');
  }
  return files.map((file) => ({ id: crypto.randomUUID(), file }));
}

export async function saveDraftImages(boardId: string, taskId: string, images: DraftImage[], current: () => boolean) {
  const path = `/api/boards/${boardId}/tasks/${taskId}`;
  for (const image of images) {
    if (!current()) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      // Read before every attempt, including recovery from an unknown response.
      const saved = await api<Collaboration>(`${path}/collaboration`, { signal: controller.signal });
      if (!current()) return;
      if (saved.attachments.some((item) => item.id === image.id && item.kind === 'file')) continue;
      await api(`${path}/attachments/file`, { ...imageUpload(image.file, image.id), signal: controller.signal });
      const confirmed = await api<Collaboration>(`${path}/collaboration`, { signal: controller.signal });
      if (!confirmed.attachments.some((item) => item.id === image.id && item.kind === 'file')) throw new Error('Сохранение изображения не подтверждено');
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Загрузка заняла больше 30 секунд.');
      throw error;
    } finally { clearTimeout(timer); }
  }
}

function ImagePreview({ image }: { image: DraftImage }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const next = URL.createObjectURL(image.file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [image.file]);
  return <img src={url} alt={image.file.name} width={64} height={64}/>;
}

export function CreateImages({ images, onAdd, onRemove, locked }: {
  images: DraftImage[]; onAdd: (files: File[]) => void; onRemove: (id: string) => void; locked: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <section className="create-images" aria-label="Изображения задачи">
    <ul className="create-image-list">{images.map((image) => <li key={image.id}>
      <ImagePreview image={image}/><span>{image.file.name}</span>
      <button type="button" className="secondary" disabled={locked} aria-label={`Удалить ${image.file.name}`} onClick={() => onRemove(image.id)}>Удалить</button>
    </li>)}</ul>
    <button type="button" className="secondary" disabled={locked} onClick={() => input.current?.click()}>Прикрепить изображение</button>
    <input ref={input} type="file" hidden multiple accept={imageTypes.join(',')} disabled={locked} aria-label="Выбрать изображения" onChange={(event) => { onAdd(Array.from(event.target.files ?? [])); event.target.value = ''; }}/>
    <p className="context-note">Вставьте скриншот или выберите файл. До нажатия «Создать» изображения остаются на устройстве; после закрытия приложения черновик не восстановится.</p>
    {!!images.length && <p role="status">Изображений в черновике: {images.length}</p>}
  </section>;
}
