# Где остановились и что дальше

Файл для продолжения работы в новой сессии: «продолжай» = начать с раздела «Следующий пункт».
Обновлено 25.11.2026, последний коммит на момент записи — `c871a49`.

## Правила работы (просьбы автора проекта)

- Общение — только по-русски; код, коммиты и идентификаторы — по-английски.
- **После каждого выполненного пункта — коммит и `git push origin main`** (GitHub Actions сам деплоит на GitHub Pages).
- **Никакой геометрии и симметрии в природе:** камни, бури, следы, рябь, грунт не должны давать квадратов,
  прямоугольников, треугольников, линеек и решёток. После любой визуальной правки — скриншот и проверка.
  Шум в шейдерах — только точные целочисленные хеши (`src/render/hash.ts`, PCG), не `fract(sin(...))`
  на больших координатах; детали гасить по пределу Найквиста (иначе муар).
- Реализм сверять с реальными фото и источниками (NASA, ALSJ, NASM, HiRISE); художественные вольности
  явно отмечать в `docs/REALISM.md`.
- Без регрессий и техдолга: проверять обе планеты (`?world=moon`, `?world=mars`), `npx tsc --noEmit`, `npm run build`.

## Сделано в сессии 24.11.2026

| Коммит | Что |
|---|---|
| `8804345` | Загрузка: `heightmap.bin` (без потерь, −31…35 %, `tools/heightmap_io.py`), Rapier `.wasm`, параллельные загрузки, декодирование картинок вне главного потока, исправлен service worker (раньше каждый запуск после деплоя грузился дважды) |
| `9c88c6d` | Видимые удары метеоритов на Луне |
| `f450117` | Экран «Старт» не ждёт детального ортоснимка и Млечного Пути |
| `2934a63` | Камни Марса как на фото Perseverance, гряда Артуби у Рочетт |
| `1e97eb3` | Извилистые следы смерчей, без муара ряби |
| `b06b2cd` | Буря на Марсе с надвигающимся фронтом, молнии, удары в ровер (повреждение электроники), исправлен цвет тумана |
| `ae81f1f` | Выход астронавта на Луне (E): прыжки при 1/6 g |
| `28e1091` | Твёрдые камни для астронавта, кислород PLSS 7 ч + OPS 30 мин |
| `aeea1c8` | Стена бури по описаниям хабубов (лопасти/расщелины, движение в м/с), без квадратов |
| `2c7f636` | Точный хеш в шейдерах колеи и следов смерчей |
| `2bcfe0e` | Автокачество: старт выше, калибровка ~25 с, разрешение ≥ 0,75, память по устройству |
| `fff67d8` | Мелкие кратеры Луны больше не исчезают при снижении качества |
| `29f44a5` | Реалистичные молнии: фрактальный канал, 3–5 обратных ударов, ядро и ореол |
| `894d377` | Скафандр A7L-B по фото; следы ботинок на каждом приземлении |
| `08580d2` | (25.11) Астронавт: один бесшовный скафандр со скиннингом (SDF → marching cubes), походки ходьба/лоуп по ALSJ, физика μ·g, наклон atan(a/g), след на каждый шаг |

## Следующий пункт: выбор локаций (в работе, 25.11.2026)

Автор ответил: **делать обе по порядку — сначала Аполлон-17, потом кратер Гейл.**

### Сделано
- `8667c3e` — данные Аполлона-17 в `public/data/apollo17/` (10,4 МБ): DTM USGS/Haase 1,5 м + ортомозаика LROC 0,5 м,
  окно 10,4×10,4 км (4000² по 2,6 м), все 9 станций внутри; шов стереомоделей DTM убран (`destripe`),
  запечённое освещение снято со снимка (`tools/deshade.py`, бывший `deshade_mars.py`); дальний рельеф и небо
  (`prepare_far.py --site apollo17`, `prepare_sky.py --site apollo17`). Конвейер: `tools/prepare_moon_site.py`,
  `tools/moon_sites.py`. Исходники в `raw_data/apollo17/` (там же `ziplist.py` — чтение ZIP-архива Haase по HTTP Range).
- `c871a49` — места посадки в `src/world.ts` (`sites`, `setSite()/site()`, `commonDir` для общих rocks/milkyway),
  `settings.site[world]`, `?site=apollo17`; хеш у каждого файла данных отдельно (`__DATA_HASHES__`), предзагрузка
  в HTML учитывает место; 9 проверенных кадров ALSJ в `public/photos/apollo17/` (lm, lrv, alsep, flag, st2, st4, st5, st6, st9).
- С `?site=apollo17` рельеф уже грузится, но миссия, журнал, ALSEP и тексты пока от Аполлона-15.

### Осталось для Аполлона-17 (по порядку)
1. Эпоха из `terrain.meta.epoch` вместо `APOLLO15_EVA1` (`src/Game.ts`: `simTime`, строки ~200 и ~244; запасные
   координаты LM ~1284).
2. `src/game/Hardware.ts`: вынести общие детали (центральная станция, SNAP-27, кабели) и добавить
   `buildAlsep17(t, cx, cz, meta.hardware)` — LEAM, LACE, LSG с зонтиком, LSP, HFE, G/M по координатам из `hardware`
   (первая попытка правки сорвалась из-за кавычек в heredoc — файл не изменён, писать через Write/Edit).
   В `addApolloHardware` выбирать по `site().id`; флаг ставить в `sites.flag`, если он есть (`addFlag`).
3. Миссия `moon17` в `src/game/Missions.ts`: m_drive → lrv → alsep → flag → lm → st5 Camelot → st4 Shorty →
   st6 Tracy → st2 Nansen → st9 Van Serg → m_home; `setMission` по `site().id`.
4. `src/game/Discoveries.ts`: таблица фото по месту (`apollo17/*.jpg`, кадры см. коммит c871a49; радиусы как у
   Аполлона-15, для кратеров побольше), ключ журнала `moon17-rover-journal`; ключ кратеров `moon-craters-apollo17`.
5. Тексты: в `src/i18n.ts` расширить `setVariant(world, site)` — ключи `<key>_apollo17` перекрывают базовые
   (titleSub, lead, chip*, credit, worldMoonSub, failTextMoon, site_*, radio_find_*, mission-moon17_*); новый
   файл `src/i18nSites.ts` (ru/uk/en/de, остальным — en). Sun 96°/16°, Earth 242°/46°, эпоха 11.12.1972 23:55 UTC.
6. Гараж: ряд кнопок мест под Луна/Марс (`index.html` ~190, `src/ui/Garage.ts`, перезагрузка как в `onWorld`
   в `src/main.ts`).
7. Проверить в браузере обе локации Луны и Марс (скриншоты, никакой геометрии в природе), tsc, build → коммит, пуш.

### Затем — кратер Гейл (Curiosity)
HiRISE DTM района Bradbury Landing (PDS / uahirise.org), CTX DTM по краям, гора Шарп на горизонте;
конвейер по образцу `tools/prepare_mars.py` + `deshade.py --dir public/data/gale`; место `gale` в `WORLDS.mars.sites`.

## Известные ограничения (честно записанные)

- Шейдер стены бури тяжеловат; пока бури нет, он не рисуется. На слабом телефоне в бурю FPS может просесть
  (автокачество должно снизить уровень).
- Разряд молнии совсем рядом с ровером в виде из кабины в тесте не был виден (сбоку виден) — проверить в игре.
- Астронавт: столкновения с камнями по центру и точке впереди тела (не по всему контуру); следы только на Луне;
  первый выход строит меш скафандра ~1,4 с (потом переиспользуется). Видео походок посмотреть нельзя —
  движения сделаны по покадровым описаниям ALSJ и физике; если покажется неестественно — уточнять по замечаниям.
- Ingenuity грузится до экрана «Старт» (2 МБ) — откладывать небезопасно без доработки гаража.

## Инструменты проверки (`tools/dev/`, в `.gitignore`)

Скрипты Playwright, которыми проверялись правки (нужен `npx vite --port 5173`): `measure.mjs`/`bench.sh`
(время загрузки), `profile.mjs`/`tree.mjs`/`callers.mjs` (CPU-профиль), `shot.mjs`, `storm.mjs`,
`strike.mjs`, `eva.mjs`/`eva2.mjs`/`evarock.mjs`, `rockshot.mjs`, `devils.mjs`, `crater.mjs`, `lowq.mjs`,
`autoq.mjs`, `rocksum.mjs` (контрольная сумма расстановки камней — Луна: 23768 валунов).
Отладочная камера: `game.debugCam = { x, z, h, az, pitch, fov }`.

## Источники, использованные в последних пунктах

- Wikipedia — Apollo/Skylab spacesuit (A7L): https://wikipedia.com/wiki/A7L
- NASM — Eugene Cernan's Lunar Overshoes: https://airandspace.si.edu/exhibition/outside-spacecraft/image-details/2035.html
- NASA ALSJ — EMU: https://www.nasa.gov/wp-content/uploads/static/history/alsj/a16/../alsj-EMU1.pdf
- WRAL — Sole of a Lunar Landing: https://www.wral.com/story/18516862/
- NASA — Bootprint on the lunar surface: https://www.nasa.gov/image-detail/bootprint-lunar-surface
- WMO Cloud Atlas — dust storm: https://cloudatlas.wmo.int/en/imgviewer-5613.txt
- Roberts & Knippertz, Weather — Haboobs: https://eprints.whiterose.ac.uk/76590/7/Weather_ARoberts_revised2_with_coversheet.pdf
- Wikipedia — Haboob: https://Wikipedia.com/wiki/Haboob
