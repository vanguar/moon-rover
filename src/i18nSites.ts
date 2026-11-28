/**
 * Strings of the landing sites other than each world's first. Keys ending in
 * `_<site id>` replace the base key while the game runs at that site (see
 * setVariant in i18n.ts); `siteBtn_<id>` label the site buttons in the garage.
 */
type Dict = Record<string, string>;

const ru: Dict = {
  siteBtn_pavonis: 'Гора Павлина · провал над пещерой',
  siteStart: 'старт',
  titleSub_pavonis: 'Гора Павлина · провал в лавовую трубу',
  worldMarsSub_pavonis: 'Гора Павлина · провал над пещерой',
  lead_pavonis:
    'Реальный рельеф склона вулкана Павлина (Pavonis Mons) на высоте 5,4 км: конический провал ~190 м с отверстием ~30 м в пустоту под ним - «окно» в подземную полость глубиной не меньше 90 м (HiRISE DTM 1 м, снимок 25 см). Вокруг - гладкий пыльный покров Тарсиса.',
  chipCoords_pavonis: '3.75°N 248.49°E',
  chipDtm_pavonis: 'DTM 1 м · 3,3×3,3 км',
  chipEpoch_pavonis: '15:00 LTST',
  chipSun_pavonis: 'Солнце 248° / 42°',
  credit_pavonis:
    'Данные: NASA / JPL-Caltech / University of Arizona - HiRISE DTM DTEEC_023531_1840_023953_1840 и снимок ESP_023531_1840; рельеф вулкана: HRSC + MOLA (ESA / DLR / FU Berlin, NASA, USGS).',
  'mission-pavonis_title': 'Окно в лавовую трубу',
  'mission-pavonis_intro':
    'Склон вулкана Павлина. Когда-то здесь под застывшей коркой текла лава; труба опустела, её свод рухнул, и грунт осыпался внутрь, оставив воронку с отверстием в полость. Подъедьте к краю воронки и сфотографируйте её. Склоны воронки - под углом естественного откоса: в неё не съехать.',
  p_rim: 'Подъедьте к краю воронки (~95 м от центра)',
  p_photo: 'Сфотографируйте провал (F)',
  'mission-pavonis_done': 'Миссия выполнена! Провал над пещерой снят.',
  site_pit: 'Провал над пещерой',
  site_pit_fact:
    'Коническая воронка ~190 м со склонами под углом естественного откоса. Грунт стёк через отверстие ~30 м в пустоту; вершина осыпи видна в 28 м под его краем. По объёму воронки полость была глубиной не меньше 90 м - на Земле таких пещер единицы.',
  siteBtn_jezero: 'Кратер Езеро · Perseverance',
  siteBtn_gale: 'Кратер Гейл · Curiosity',
  siteSoon: 'скоро',
  siteLabel: 'Место посадки:',
  siteBtn_apollo15: 'Борозда Хэдли · Аполлон-15',
  siteBtn_apollo17: 'Тавр-Литтров · Аполлон-17',
  siteLoading: 'Перелёт на другое место посадки…',
  titleSub_apollo17: 'Долина Тавр-Литтров · Аполлон-17',
  worldMoonSub_apollo17: 'Тавр-Литтров · Аполлон-17',
  lead_apollo17:
    'Реальный рельеф долины Тавр-Литтров, где работала последняя экспедиция «Аполлон» (DTM USGS 1,5 м и ортомозаика LROC 0,5 м), между Северным и Южным массивами, с уступом Ли-Линкольн и горами вокруг (SLDEM2015). Солнце, Земля и звёзды — как в начале первого выхода, 11 декабря 1972 года.',
  chipCoords_apollo17: '20.19°N 30.77°E',
  chipDtm_apollo17: 'DTM 1,5 м · 10×10 км',
  chipEpoch_apollo17: '11.12.1972 23:55 UTC',
  chipSun_apollo17: 'Солнце 96° / 16°',
  credit_apollo17:
    'Данные: USGS / Haase et al. 2018 — DTM и ортомозаика долины Тавр-Литтров по снимкам LRO LROC NAC (NASA / GSFC / Arizona State University), опорные точки места посадки; SLDEM2015. Снимки: NASA, Apollo Lunar Surface Journal. Звёзды: Yale Bright Star Catalog.',
  failTextMoon_apollo17:
    'Ровер сорвался с крутого склона: круче 35°, перепад в десятки метров. Колёса и подвеска разбиты, вернуться к модулю невозможно. Настоящий LRV был рассчитан на склоны не круче 25°.',
  'mission-moon17_title': 'По следам Сернана и Шмитта',
  'mission-moon17_intro':
    'Долина Тавр-Литтров, декабрь 1972 года, последняя экспедиция «Аполлон». Вы на ровере у посадочного модуля «Челленджер». Пройдите станции второго и третьего выходов, сфотографируйте их и вернитесь к модулю. Батарея заряжается только на солнце: в тени массивов и кратеров она лишь разряжается, а электроника остывает. У модуля можно подзарядиться.',
  m17_lrv: 'Найдите LRV «Аполлона-17» на месте последней стоянки и сфотографируйте его (F)',
  m17_alsep: 'Сфотографируйте станцию научных приборов ALSEP',
  m17_flag: 'Сфотографируйте флаг, у которого стоял Шмитт',
  m17_lm: 'Сделайте снимок посадочной ступени «Челленджер»',
  m17_st2: 'Станция 2: валуны у кратера Нансен под Южным массивом, ~7,5 км. Сфотографируйте',
  m17_st4: 'Станция 4: кратер Шорти, где нашли оранжевый грунт. Сфотографируйте',
  m17_st5: 'Станция 5: глыбы на краю кратера Камелот. Сфотографируйте',
  m17_st6: 'Станция 6: расколотый валун у подножия Северного массива. Сфотографируйте',
  m17_st9: 'Станция 9: кратер Ван-Серг. Сфотографируйте',
  'mission-moon17_done': 'Миссия выполнена! Все станции «Аполлона-17» сняты.',
  site_lm_apollo17: 'Посадочная ступень «Челленджер»',
  site_lm_fact_apollo17:
    'Здесь 11 декабря 1972 года сели Юджин Сернан и Харрисон Шмитт — геолог, единственный учёный среди лунных астронавтов. За три выхода они провели снаружи 22 часа. Взлётная ступень ушла 14 декабря; с тех пор на Луне не был никто.',
  site_lrv_fact_apollo17:
    'LRV «Аполлона-17» проехал около 36 км. Оторванное крыло экипаж починил картами и зажимами от ламп. Последняя стоянка — ~150 м к востоку от модуля, телекамерой на «Челленджер»: из Хьюстона по ней сняли старт.',
  site_alsep_fact_apollo17:
    'Последняя станция ALSEP: гравиметр, датчики пыли и микрометеоритов (LEAM), масс-спектрометр следов атмосферы (LACE), тепловой поток в скважинах и сейсмопрофилирование — после старта модуля здесь взорвали восемь зарядов. Питание — радиоизотопный генератор; станцию выключили в 1977 году.',
  site_flag: 'Флаг и Земля',
  site_flag_fact:
    'Знаменитый кадр AS17-134-20384: Шмитт у флага, над ним — Земля. С Луны Земля почти не движется по небу: Луна всегда обращена к ней одной стороной, и в Тавре-Литтрове Земля висит на юго-западе, на высоте около 45°.',
  site_st2: 'Станция 2 · кратер Нансен',
  site_st2_fact:
    'Самая дальняя точка выходов, ~7,5 км от модуля, у подножия Южного массива. Валуны скатились со склона массива; брекчии в них образовались при ударах, создавших бассейн Ясности, около 3,9 млрд лет назад.',
  site_st4: 'Станция 4 · кратер Шорти',
  site_st4_fact:
    '«Здесь оранжевый грунт!» — Шмитт. Это стеклянные бусинки вулканического происхождения: 3,6 млрд лет назад здесь били огненные фонтаны лавы. Кратер Шорти (~110 м) вскрыл этот слой.',
  site_st5: 'Станция 5 · кратер Камелот',
  site_st5_fact:
    'Кратер диаметром ~600 м. Глыбы на его краю — базальт, выброшенный из-под реголита с глубины в десятки метров: лава, залившая долину. На кадре Шмитт бежит к роверу с совком.',
  site_st6: 'Станция 6 · камень Трейси',
  site_st6_fact:
    'Расколотый валун размером с дом скатился с Северного массива — его след виден на склоне. Сернан позже жалел, что не написал на пыли имя дочери; это сделал за него художник и астронавт Алан Бин на своей картине.',
  site_st9: 'Станция 9 · кратер Ван-Серг',
  site_st9_fact:
    'Кратер диаметром ~90 м. До полёта его считали вулканическим, но он оказался ударным: на краю лежат брекчии из спёкшегося реголита. Рядом нашли слой светлого грунта.',
  radio_find_lm_apollo17: 'Отличный снимок «Челленджера». Записали.',
  radio_find_lrv_apollo17: 'Вот он, ровер, камерой на модуль — как его оставил Джин. Отличный снимок.',
  radio_find_alsep_apollo17: 'ALSEP в кадре. Записали, спасибо.',
  radio_find_flag: 'Флаг и Земля над ним. Красивый кадр.',
  radio_find_st2: 'Нансен, станция два. Записали.',
  radio_find_st4: 'Шорти! Оранжевый грунт — помним, как Джек кричал. Записали.',
  radio_find_st5: 'Камелот, станция пять. Записали.',
  radio_find_st6: 'Камень Трейси! Записали.',
  radio_find_st9: 'Ван-Серг, станция девять. Записали.',
};

const uk: Dict = {
  siteBtn_pavonis: 'Гора Павича · провал над печерою',
  siteStart: 'старт',
  titleSub_pavonis: 'Гора Павича · провал у лавову трубу',
  worldMarsSub_pavonis: 'Гора Павича · провал над печерою',
  lead_pavonis:
    'Реальний рельєф схилу вулкана Павича (Pavonis Mons) на висоті 5,4 км: конічний провал ~190 м з отвором ~30 м у порожнину під ним - «вікно» в підземну порожнину глибиною щонайменше 90 м (HiRISE DTM 1 м, знімок 25 см).',
  chipDtm_pavonis: 'DTM 1 м · 3,3×3,3 км',
  chipSun_pavonis: 'Сонце 248° / 42°',
  'mission-pavonis_title': 'Вікно в лавову трубу',
  'mission-pavonis_intro':
    'Схил вулкана Павича. Колись тут під застиглою кіркою текла лава; труба спорожніла, її склепіння обвалилося, і ґрунт осипався всередину. Під’їдьте до краю вирви й сфотографуйте її. Схили вирви - під кутом природного укосу: у неї не з’їхати.',
  p_rim: 'Під’їдьте до краю вирви (~95 м від центру)',
  p_photo: 'Сфотографуйте провал (F)',
  'mission-pavonis_done': 'Місію виконано! Провал над печерою знято.',
  site_pit: 'Провал над печерою',
  site_pit_fact:
    'Конічна вирва ~190 м зі схилами під кутом природного укосу. Ґрунт стік крізь отвір ~30 м у порожнину; вершина осипу видна за 28 м під його краєм. За об’ємом вирви порожнина була глибиною щонайменше 90 м.',
  siteBtn_jezero: 'Кратер Єзеро · Perseverance',
  siteBtn_gale: 'Кратер Гейл · Curiosity',
  siteSoon: 'незабаром',
  siteLabel: 'Місце посадки:',
  siteBtn_apollo15: 'Борозна Хедлі · Аполлон-15',
  siteBtn_apollo17: 'Тавр-Літтров · Аполлон-17',
  siteLoading: 'Переліт на інше місце посадки…',
  titleSub_apollo17: 'Долина Тавр-Літтров · Аполлон-17',
  worldMoonSub_apollo17: 'Тавр-Літтров · Аполлон-17',
  lead_apollo17:
    'Реальний рельєф долини Тавр-Літтров, де працювала остання експедиція «Аполлон» (DTM USGS 1,5 м і ортомозаїка LROC 0,5 м), між Північним і Південним масивами, з уступом Лі-Лінкольн і горами довкола (SLDEM2015). Сонце, Земля й зорі — як на початку першого виходу, 11 грудня 1972 року.',
  chipDtm_apollo17: 'DTM 1,5 м · 10×10 км',
  chipEpoch_apollo17: '11.12.1972 23:55 UTC',
  chipSun_apollo17: 'Сонце 96° / 16°',
  credit_apollo17:
    'Дані: USGS / Haase et al. 2018 — DTM і ортомозаїка долини Тавр-Літтров за знімками LRO LROC NAC (NASA / GSFC / Arizona State University); SLDEM2015. Знімки: NASA, Apollo Lunar Surface Journal. Зорі: Yale Bright Star Catalog.',
  failTextMoon_apollo17:
    'Ровер зірвався з крутого схилу: крутіший за 35°, перепад у десятки метрів. Колеса й підвіска розбиті, повернутися до модуля неможливо. Справжній LRV розрахували на схили не крутіші за 25°.',
  jNote_apollo17: 'Під’їжджайте до місць місії й фотографуйте їх (F): відкриється архівний знімок NASA з цього місця.',
  'mission-moon17_title': 'Слідами Сернана та Шмітта',
  'mission-moon17_intro':
    'Долина Тавр-Літтров, грудень 1972 року, остання експедиція «Аполлон». Ви на ровері біля посадкового модуля «Челленджер». Пройдіть станції другого й третього виходів, сфотографуйте їх і поверніться до модуля. Батарея заряджається лише на сонці; біля модуля можна підзарядитися.',
  m17_lrv: 'Знайдіть LRV «Аполлона-17» на місці останньої стоянки й сфотографуйте (F)',
  m17_alsep: 'Сфотографуйте станцію приладів ALSEP',
  m17_flag: 'Сфотографуйте прапор, біля якого стояв Шмітт',
  m17_lm: 'Зробіть знімок посадкового ступеня «Челленджер»',
  m17_st2: 'Станція 2: валуни біля кратера Нансен під Південним масивом, ~7,5 км. Сфотографуйте',
  m17_st4: 'Станція 4: кратер Шорті, де знайшли помаранчевий ґрунт. Сфотографуйте',
  m17_st5: 'Станція 5: брили на краю кратера Камелот. Сфотографуйте',
  m17_st6: 'Станція 6: розколотий валун біля підніжжя Північного масиву. Сфотографуйте',
  m17_st9: 'Станція 9: кратер Ван-Серг. Сфотографуйте',
  'mission-moon17_done': 'Місію виконано! Усі станції «Аполлона-17» знято.',
  site_lm_apollo17: 'Посадковий ступінь «Челленджер»',
  site_lm_fact_apollo17:
    'Тут 11 грудня 1972 року сіли Юджин Сернан і Гаррісон Шмітт — геолог, єдиний науковець серед місячних астронавтів. За три виходи вони провели назовні 22 години. Злітний ступінь пішов 14 грудня; відтоді на Місяці не був ніхто.',
  site_lrv_fact_apollo17:
    'LRV «Аполлона-17» проїхав близько 36 км. Відірване крило екіпаж полагодив картами й затискачами від ламп. Остання стоянка — ~150 м на схід від модуля, камерою на «Челленджер»: з Х’юстона нею зняли старт.',
  site_alsep_fact_apollo17:
    'Остання станція ALSEP: гравіметр, датчики пилу й мікрометеоритів, мас-спектрометр слідів атмосфери, тепловий потік у свердловинах і сейсмопрофілювання — після старту тут підірвали вісім зарядів. Станцію вимкнули 1977 року.',
  site_flag: 'Прапор і Земля',
  site_flag_fact:
    'Відомий кадр AS17-134-20384: Шмітт біля прапора, над ним — Земля. З Місяця Земля майже не рухається небом: Місяць завжди повернутий до неї одним боком.',
  site_st2: 'Станція 2 · кратер Нансен',
  site_st2_fact: 'Найдальша точка виходів, ~7,5 км від модуля, біля підніжжя Південного масиву. Валуни скотилися зі схилу; брекчії в них утворилися близько 3,9 млрд років тому.',
  site_st4: 'Станція 4 · кратер Шорті',
  site_st4_fact: '«Тут помаранчевий ґрунт!» — Шмітт. Це скляні намистинки вулканічного походження: 3,6 млрд років тому тут били вогняні фонтани лави.',
  site_st5: 'Станція 5 · кратер Камелот',
  site_st5_fact: 'Кратер діаметром ~600 м. Брили на його краю — базальт, викинутий з-під реголіту: лава, що залила долину.',
  site_st6: 'Станція 6 · камінь Трейсі',
  site_st6_fact: 'Розколотий валун завбільшки з будинок скотився з Північного масиву. Сернан шкодував, що не написав на пилу ім’я доньки; це зробив за нього на своїй картині Алан Бін.',
  site_st9: 'Станція 9 · кратер Ван-Серг',
  site_st9_fact: 'Кратер діаметром ~90 м. До польоту його вважали вулканічним, але він виявився ударним: на краю лежать брекчії зі спеченого реголіту.',
  radio_find_lm_apollo17: 'Чудовий знімок «Челленджера». Записали.',
  radio_find_lrv_apollo17: 'Ось він, ровер, камерою на модуль. Чудовий знімок.',
  radio_find_alsep_apollo17: 'ALSEP у кадрі. Записали.',
  radio_find_flag: 'Прапор і Земля над ним. Гарний кадр.',
  radio_find_st2: 'Нансен, станція два. Записали.',
  radio_find_st4: 'Шорті! Помаранчевий ґрунт. Записали.',
  radio_find_st5: 'Камелот, станція п’ять. Записали.',
  radio_find_st6: 'Камінь Трейсі! Записали.',
  radio_find_st9: 'Ван-Серг, станція дев’ять. Записали.',
};

const en: Dict = {
  siteBtn_pavonis: 'Pavonis Mons · cave skylight',
  siteStart: 'start',
  titleSub_pavonis: 'Pavonis Mons · lava-tube skylight',
  worldMarsSub_pavonis: 'Pavonis Mons · cave skylight',
  lead_pavonis:
    'Real terrain of the flank of Pavonis Mons, 5.4 km up: a conical collapse ~190 m across with a ~30 m opening into a void below - a skylight into a cavity at least 90 m deep (HiRISE DTM 1 m, image 25 cm). Around it, the smooth dust mantle of Tharsis.',
  chipCoords_pavonis: '3.75°N 248.49°E',
  chipDtm_pavonis: 'DTM 1 m · 3.3×3.3 km',
  chipEpoch_pavonis: '15:00 LTST',
  chipSun_pavonis: 'Sun 248° / 42°',
  credit_pavonis:
    'Data: NASA / JPL-Caltech / University of Arizona - HiRISE DTM DTEEC_023531_1840_023953_1840 and image ESP_023531_1840; volcano terrain: HRSC + MOLA (ESA / DLR / FU Berlin, NASA, USGS).',
  'mission-pavonis_title': 'A window into a lava tube',
  'mission-pavonis_intro':
    'The flank of Pavonis Mons. Lava once flowed here under a frozen crust; the tube drained, its roof fell in and the ground poured into it, leaving a funnel with an opening into the void. Drive to the lip of the funnel and photograph it. Its walls stand at the angle of repose: no rover drives down them.',
  p_rim: 'Drive to the lip of the funnel (~95 m from its centre)',
  p_photo: 'Photograph the collapse (F)',
  'mission-pavonis_done': 'Mission complete! The cave skylight is photographed.',
  site_pit: 'Collapse over a cave',
  site_pit_fact:
    'A conical funnel ~190 m across with walls at the angle of repose. The ground drained through a ~30 m opening into a void; the top of its debris pile is seen 28 m below the rim. From the funnel volume the cavity was at least 90 m deep - only a handful of caves on Earth are that big.',
  siteBtn_jezero: 'Jezero crater · Perseverance',
  siteBtn_gale: 'Gale crater · Curiosity',
  siteSoon: 'coming soon',
  siteLabel: 'Landing site:',
  siteBtn_apollo15: 'Hadley Rille · Apollo 15',
  siteBtn_apollo17: 'Taurus-Littrow · Apollo 17',
  siteLoading: 'Flying to the other landing site…',
  titleSub_apollo17: 'Taurus-Littrow Valley · Apollo 17',
  worldMoonSub_apollo17: 'Taurus-Littrow · Apollo 17',
  lead_apollo17:
    'Real terrain of the Taurus-Littrow valley, where the last Apollo crew worked (USGS DTM 1.5 m and LROC orthomosaic 0.5 m), between the North and South Massifs, with the Lee-Lincoln scarp and the mountains around (SLDEM2015). Sun, Earth and stars as at the start of the first moonwalk, 11 December 1972.',
  chipCoords_apollo17: '20.19°N 30.77°E',
  chipDtm_apollo17: 'DTM 1.5 m · 10×10 km',
  chipEpoch_apollo17: '1972-12-11 23:55 UTC',
  chipSun_apollo17: 'Sun 96° / 16°',
  credit_apollo17:
    'Data: USGS / Haase et al. 2018 — Taurus-Littrow DTM and orthomosaic from LRO LROC NAC images (NASA / GSFC / Arizona State University), landing-site control points; SLDEM2015. Photos: NASA, Apollo Lunar Surface Journal. Stars: Yale Bright Star Catalog.',
  failTextMoon_apollo17:
    'The rover went over a slope steeper than 35°, a drop of tens of metres. Wheels and suspension are wrecked; there is no way back to the LM. The real LRV was rated for slopes up to 25°.',
  jNote_apollo17: 'Drive to the mission sites and photograph them (F) to open the real NASA frame taken there.',
  'mission-moon17_title': 'In the tracks of Cernan and Schmitt',
  'mission-moon17_intro':
    'Taurus-Littrow, December 1972, the last Apollo expedition. You are on a rover next to the lunar module Challenger. Visit the stations of the second and third moonwalks, photograph them and return to the LM. The battery charges only in sunlight: in the shadow of the massifs and craters it only drains and the electronics cool down. You can recharge at the LM.',
  m17_lrv: 'Find the Apollo 17 LRV at its last parking spot and photograph it (F)',
  m17_alsep: 'Photograph the ALSEP science station',
  m17_flag: 'Photograph the flag where Schmitt stood',
  m17_lm: 'Take a picture of the descent stage of Challenger',
  m17_st2: 'Station 2: boulders at Nansen crater below the South Massif, ~7.5 km. Photograph them',
  m17_st4: 'Station 4: Shorty crater, where the orange soil was found. Photograph it',
  m17_st5: 'Station 5: blocks on the rim of Camelot crater. Photograph them',
  m17_st6: 'Station 6: the split boulder at the foot of the North Massif. Photograph it',
  m17_st9: 'Station 9: Van Serg crater. Photograph it',
  'mission-moon17_done': 'Mission complete! All Apollo 17 stations photographed.',
  site_lm_apollo17: 'Descent stage of Challenger',
  site_lm_fact_apollo17:
    'Eugene Cernan and Harrison Schmitt — a geologist, the only scientist among the moonwalkers — landed here on 11 December 1972. In three moonwalks they spent 22 hours outside. The ascent stage left on 14 December; no one has been on the Moon since.',
  site_lrv_fact_apollo17:
    'The Apollo 17 Rover covered about 36 km. The crew repaired a torn-off fender with maps and lamp clamps. Final parking ~150 m east of the LM, its TV camera on Challenger: Houston filmed the lift-off through it.',
  site_alsep_fact_apollo17:
    'The last ALSEP: a gravimeter, a dust and micrometeorite detector (LEAM), a mass spectrometer for the trace atmosphere (LACE), heat flow in drill holes and seismic profiling — eight charges were fired here after the LM left. Powered by a radioisotope generator; switched off in 1977.',
  site_flag: 'The flag and the Earth',
  site_flag_fact:
    'The famous frame AS17-134-20384: Schmitt by the flag, the Earth above him. Seen from the Moon the Earth hardly moves across the sky — the Moon always keeps the same face toward it; at Taurus-Littrow it hangs in the south-west, about 45° up.',
  site_st2: 'Station 2 · Nansen crater',
  site_st2_fact:
    'The farthest point of the moonwalks, ~7.5 km from the LM, at the foot of the South Massif. The boulders rolled down the massif; their breccias formed in the impacts that made the Serenitatis basin, about 3.9 billion years ago.',
  site_st4: 'Station 4 · Shorty crater',
  site_st4_fact:
    '"There is orange soil!" — Schmitt. It is beads of volcanic glass: 3.6 billion years ago fire fountains of lava played here. Shorty (~110 m) dug the layer up.',
  site_st5: 'Station 5 · Camelot crater',
  site_st5_fact:
    'A crater ~600 m across. The blocks on its rim are basalt thrown up from tens of metres below the regolith — the lava that floods the valley. In the frame Schmitt runs back to the Rover with the scoop.',
  site_st6: 'Station 6 · Tracy’s Rock',
  site_st6_fact:
    'A house-size split boulder that rolled down the North Massif — its track is visible on the slope. Cernan later wished he had written his daughter’s name in the dust; astronaut-artist Alan Bean did it for him in a painting.',
  site_st9: 'Station 9 · Van Serg crater',
  site_st9_fact:
    'A crater ~90 m across. Before the flight it was thought volcanic; it turned out to be an impact crater, its rim strewn with breccias of welded regolith. A layer of light soil was found next to it.',
  radio_find_lm_apollo17: 'Beautiful shot of Challenger. Copy.',
  radio_find_lrv_apollo17: 'There’s the Rover, camera on the LM, right where Gene left it. Great picture.',
  radio_find_alsep_apollo17: 'ALSEP in view. Copy, thanks.',
  radio_find_flag: 'The flag, and the Earth above it. Beautiful.',
  radio_find_st2: 'Nansen, station two. Copy.',
  radio_find_st4: 'Shorty! Orange soil — we remember Jack’s call. Copy.',
  radio_find_st5: 'Camelot, station five. Copy.',
  radio_find_st6: 'Tracy’s Rock! Copy.',
  radio_find_st9: 'Van Serg, station nine. Copy.',
};

const de: Dict = {
  siteBtn_pavonis: 'Pavonis Mons · Höhlenschacht',
  titleSub_pavonis: 'Pavonis Mons · Lavaröhren-Schacht',
  worldMarsSub_pavonis: 'Pavonis Mons · Höhlenschacht',
  siteBtn_jezero: 'Krater Jezero · Perseverance',
  siteBtn_gale: 'Krater Gale · Curiosity',
  siteSoon: 'bald',
  siteLabel: 'Landeplatz:',
  siteBtn_apollo15: 'Hadley-Rille · Apollo 15',
  siteBtn_apollo17: 'Taurus-Littrow · Apollo 17',
  titleSub_apollo17: 'Taurus-Littrow-Tal · Apollo 17',
  worldMoonSub_apollo17: 'Taurus-Littrow · Apollo 17',
  lead_apollo17:
    'Echtes Gelände des Taurus-Littrow-Tals, wo die letzte Apollo-Crew arbeitete (USGS-DTM 1,5 m und LROC-Orthomosaik 0,5 m), zwischen Nord- und Südmassiv, mit der Lee-Lincoln-Stufe und den Bergen ringsum (SLDEM2015). Sonne, Erde und Sterne wie zu Beginn des ersten Mondspaziergangs am 11. Dezember 1972.',
  chipDtm_apollo17: 'DTM 1,5 m · 10×10 km',
  chipSun_apollo17: 'Sonne 96° / 16°',
};

const ar: Dict = {
  siteBtn_pavonis: 'جبل بافونيس · فتحة كهف',
  titleSub_pavonis: 'جبل بافونيس · فتحة أنبوب حمم',
  worldMarsSub_pavonis: 'جبل بافونيس · فتحة كهف',
  siteBtn_jezero: 'فوهة جيزيرو · Perseverance',
  siteBtn_gale: 'فوهة غيل · Curiosity',
  siteSoon: 'قريبًا',
  siteLabel: 'موقع الهبوط:',
  siteBtn_apollo15: 'أخدود هادلي · أبولو 15',
  siteBtn_apollo17: 'توروس-ليترو · أبولو 17',
  titleSub_apollo17: 'وادي توروس-ليترو · أبولو 17',
  worldMoonSub_apollo17: 'توروس-ليترو · أبولو 17',
  chipDtm_apollo17: 'DTM 1.5 م · 10×10 كم',
  chipSun_apollo17: 'الشمس 96° / 16°',
};

const zh: Dict = {
  siteBtn_pavonis: '孔雀山 · 洞穴天窗',
  titleSub_pavonis: '孔雀山 · 熔岩管天窗',
  worldMarsSub_pavonis: '孔雀山 · 洞穴天窗',
  siteBtn_jezero: '耶泽罗陨石坑 · Perseverance',
  siteBtn_gale: '盖尔陨石坑 · Curiosity',
  siteSoon: '即将推出',
  siteLabel: '着陆点：',
  siteBtn_apollo15: '哈德利月溪 · 阿波罗15号',
  siteBtn_apollo17: '金牛-利特罗 · 阿波罗17号',
  titleSub_apollo17: '金牛-利特罗谷 · 阿波罗17号',
  worldMoonSub_apollo17: '金牛-利特罗 · 阿波罗17号',
  chipDtm_apollo17: 'DTM 1.5 米 · 10×10 公里',
  chipSun_apollo17: '太阳 96° / 16°',
};

export const SITE_STRINGS: Record<string, Dict> = { ru, uk, en, de, ar, zh };
