## User Review

> [!USER REVIEW]
> Przed publikacją datasetu potrzebny jest docelowy owner/URL repo oraz wybór public/private. Tych danych nie ma w rozmowie. Przygotować i sprawdzić cały dataset lokalnie przed ustaleniem publikacji; nie blokuje to implementacji integracji. Nie publikować materiałów na przypadkowym koncie ani nie wpisywać fikcyjnego URL jako działającej konfiguracji.

Aktualizacja zatwierdzona przez użytkownika 2026-10-27: dostosować integrację do zachowanego Benchmark Center (`fresh-completion`). Wykorzystać wspólny runner, panel i accounting; dobudować pobieranie datasetu oraz izolację Memory. Nie odtwarzać wycofanych rodzin benchmarków ani usuniętej ścieżki SDK; produkcja i pomiary korzystają z App Server. Ten zapis zastępuje historyczny warunek ukończenia nieobecnego planu 01 oraz odwołania do jego usuniętych API. Wersja pierwsza używa Basic Memory lokalnie; Hindsight pozostaje poza zakresem.

## Risk

- Pamięć może zwiększyć usage albo utrwalać błędne/nieaktualne ustalenia. Oszczędność jest hipotezą; wyniki muszą obejmować jakość, koszt, czas i zakres błędów, także w zadaniach bez korzyści z pamięci.
- Dane należą do użytkownika. Anulowanie, awaria i wyłączenie nie mogą usuwać jego notatek ani zmieniać globalnego projektu Basic Memory. Nie używać prawdziwej pamięci do benchmarku.
- MCP `write` nie jest automatycznie blokowane przez filesystem `read-only` agenta. Egzekwować scope projektu i uprawnienia roli po stronie adaptera/backendu. Zwykła instrukcja w promptcie nie zapewnia izolacji.
- Pamięć z wycofanego turna, starego brancha lub bocznego agenta nie może wrócić jako aktualny, zatwierdzony fakt. Potrzebne są provenance, status i kontrola konfliktów zapisów.
- Research z 2026-10-26 wskazał osobny runtime Python oraz licencję AGPL Basic Memory. Przed wdrożeniem potwierdzić kontrakt wybranej wersji w oficjalnych źródłach i zachować integrację przez osobny proces, bez niejawnego vendoringu/pobierania w zwykłym npm install. Research nie jest dowodem live kompatybilności.
- Obecny checkout jest zmodyfikowany, a po planie 01 zmienią się entrypointy benchmarków. Zachować istniejące diffy; nie tworzyć niezamówionych branchy/worktree ani nie odtwarzać starych plików z tego planu na siłę.

## Task description

### Cel i wymagania produktu

Wprowadzić opcjonalną pamięć projektu do agentów Pace z małym, mierzonym narzutem. Obsługa jest wbudowana w obecne repo i publikowana z `@sidearker/pace`; Basic Memory pozostaje osobno instalowanym backendem. Nie powstaje osobna paczka npm setupu ani ogólny system extensions. Samo używanie Pace nie wymaga pamięci.

Wpisanie `/memory` otwiera automatycznie interaktywny setup, jeśli projekt nie ma konfiguracji. Poprawnie skonfigurowana, ale pusta baza otwiera panel; wyłączona pamięć otwiera panel ze stanem; awaria otwiera naprawę połączenia, bez tworzenia nowej bazy.

Backend wybieramy i instalujemy wyłącznie w świadomie uruchomionym setupie; zwykły `npm install` Pace nie pobiera Pythona, modeli ani Basic Memory. Zmiany ustawień obowiązują od kolejnego uruchomienia agenta, bez podmiany połączeń aktywnego turna.

Benchmark ma używać osobnego, pobieranego repo z fikcyjnym projektem i gotową pamięcią wygenerowaną przez wcześniejszego agenta. Zwykły agent pracuje sam na tym samym kodzie, bez tej pamięci. Panel/runner pochodzą z planu 01 i pozostają debug-only; `/memory` jest zwykłą funkcją produktu, również w instalacji npm.

### Zweryfikowane punkty oparcia i zależność

| Obszar | Obecne pliki i ustalenia |
| --- | --- |
| Komendy/panele | [commands.ts](../../src/components/app/commands.ts), [submit.ts](../../src/components/app/submit.ts), [info-commands.ts](../../src/components/app/info-commands.ts), [AppView.tsx](../../src/components/app/AppView.tsx), [useAppState.ts](../../src/components/app/useAppState.ts); [McpManager](../../src/components/McpManager.tsx) zapewnia wzorzec wizardu i cancellation. |
| Config | [shared/config.ts](../../src/shared/config.ts), [shared/types.ts](../../src/shared/types.ts), [sessions.ts](../../src/core/sessions.ts): parsowanie i trwały zapis config. |
| Transport | [app-server-process.ts](../../src/integrations/app-server-process.ts) buduje argumenty MCP Vex; [app-server-runner.ts](../../src/integrations/app-server-runner.ts) używa App Server; konfiguracja MCP działa przez App Server. [codex-cli.ts](../../src/integrations/codex-cli.ts) deleguje zarządzanie zewnętrznym MCP do Codex CLI. Sama konfiguracja globalnego MCP nie realizuje polityki projektu/roli pamięci. |
| Prompt i zapis | [orchestrator-prompts.ts](../../src/core/orchestrator-prompts.ts): `prepareRunnerPrompt` ustala nowy thread/checkpoint; [checkpoint.ts](../../src/core/checkpoint.ts) tworzy walidowaną notatkę; [turn-runner.ts](../../src/components/turn-runner.ts) wyzwala checkpoint po pracy. |
| Historia i role | [session-model.ts](../../src/core/session-model.ts), [file-history.ts](../../src/core/file-history.ts), [sessions-revisions.ts](../../src/core/sessions-revisions.ts), [side-answers.ts](../../src/core/side-answers.ts), [operations.ts](../../src/core/operations.ts): undo/redo, współbieżne sesje i role. |
| Benchmark | Plan 01 dostarcza profile, runner, panel, pinned download, izolację i accounting. Po jego wykonaniu ponownie ustalić faktyczne ścieżki API; nie kopiować nowego runnera obok istniejącego. |

Źródła projektowe: [ustalenia integracji](../agent-memory-integration.md), [research](../agent-memory-research-2026-10-26.md), [manifest źródeł](../agent-memory-research-sources-2026-10-26.json), [projekt benchmarku](../benchmark-center.md). Ten plan zawiera wymagania potrzebne do wykonania bez dostępu do rozmowy; research pomaga zweryfikować wersję narzędzi.

## Comparison

| Stan przed implementacją | Stan docelowy |
| --- | --- |
| Historia/checkpointy Pace bez nowego magazynu pamięci | Ta sama praca plus opcjonalna trwała pamięć projektu |
| Brak `/memory` | Setup, panel i naprawa pod jedną komendą |
| Brak pomiaru gotowego doświadczenia | Zamrożony dataset, A/B i osobny koszt przygotowania |
| Potencjalny pełny dump notatek do kontekstu | Mały recall i dalsze, jawnie mierzone odczyty na żądanie |

## Implementation steps

### 1. Potwierdzić gotowość Benchmark Center i kontrakt backendu

1. Zweryfikować warunki odbioru planu 01 oraz istniejące diffy. Nie rozpoczynać implementacji pamięci, jeśli Benchmark Center nie ma jeszcze wymaganej migracji rodzin, accounting i izolacji. Naprawić brak planu 01 przed przejściem dalej.
2. Sprawdzić oficjalny kontrakt konkretnej wersji Basic Memory: uruchamianie lokalne, obsługiwane systemy/runtime, wybór projektu, search, graf, read/write, eksport/import, synchronizacja i indeksowanie. Zanotować wersję, URL źródeł i rzeczywiście sprawdzone możliwości. Nie używać nazw argumentów ze starego researchu bez weryfikacji.
3. W `src/` wydzielić mały moduł integracji Basic Memory i polityki Pace, np. `src/core/memory/` plus moduł procesu w `src/integrations/`. Wykorzystać obecny MCP SDK/transport; nie dodawać interfejsu na wiele providerów bez drugiego klienta. Polityka musi być współdzielona przez produkcję i benchmark.

### 2. Konfiguracja projektu i lifecycle backendu

1. Dodać wersjonowaną, walidowaną konfigurację pod `~/.pace` przypisaną do stabilnej tożsamości projektu i canonical path; przechowywać ID projektu backendu, lokalizację danych, enabled i stan setupu. Stary config bez pamięci nadal działa. Nie utożsamiać wszystkich repo o tej samej nazwie/remote z jednym projektem bez decyzji użytkownika.
2. Każda operacja dostaje jawny project ID oraz scope roli/zadania; nie przełączać globalnego „active project” backendu. Branch/commit i źródła należą do provenance, a zasady dzielenia ustaleń między branchami są jawne.
3. Rozróżnić unconfigured, configuring, ready, disabled, unavailable. Zachować poprzedni gotowy config do czasu zatwierdzenia nowego. Niedokończony setup nie jest pustą gotową bazą.
4. Wykryć istniejący program/runtime i używać ich po walidacji. Nową instalację przeprowadzać w izolowanym środowisku użytkownika, zgodnie z udokumentowanym sposobem wybranej wersji. Nie wymagać sudo i nie instalować przez niezweryfikowane polecenie sklejone z inputu.
5. Zarządzać wyłącznie należącymi do Pace procesami/połączeniami. Awaria lub timeout pamięci ma dać widoczny, zapisany stan degraded i pozwolić na zwykłą pracę; nie wolno zgłosić udanego zapisu, którego nie potwierdzono. Ponawianie zapisów musi być idempotentne i ograniczone.

### 3. Interaktywny `/memory`

1. Podłączyć komendę, autocomplete/help i panel zgodnie z istniejącą kompozycją App. Nie ograniczać `/memory` mechanizmem debug używanym przez `/benchmark`.
2. Brak config automatycznie uruchamia wizard: wyjaśnienie zakresu → wykrycie instalacji/runtime → istniejąca pamięć lub nowy katalog → podsumowanie → instalacja/konfiguracja → kontrola połączenia i projektu → zapis ready → panel.
3. Wizard używa strzałek/Enter/Esc, pokazuje postęp oraz błędy i pozwala anulować. Jeśli wykonał część instalacji, informuje co pozostało; nie odinstalowuje cudzej instalacji ani nie usuwa notatek. Próba zapisu używa własnego tymczasowego rekordu i usuwa tylko ten rekord.
4. Panel gotowej pamięci pokazuje backend, projekt, lokalizację i stan, umożliwia enable/disable oraz ponowną konfigurację/naprawę. Pusta baza otwiera normalny panel. Awaria nie uruchamia pierwszego setupu ani nie tworzy drugiej bazy. Disable zachowuje dane.
5. Zmiana config dotyczy następnych uruchomień agenta. Nie zmieniać uprawnień lub projektu aktywnego turna w trakcie jego działania.

### 4. Selektywny recall i egzekwowane uprawnienia

1. Dodać ograniczony recall przy rozpoczęciu nowego zadania/threadu w produkcyjnej ścieżce budowania promptu. Używać istniejącej klasyfikacji task relation; nie dodawać keyword classifiera ani nowego płatnego routera. Nie wykonywać automatycznego recall przy każdym zwykłym turnie.
2. Parametry startowe pilota: 3–5 krótkich wyników, graf depth 1, 1–2 wybrane notatki i pakiet do około 600–1000 tokenów. Brak trafień oznacza brak pakietu. Progi są konfiguracją polityki, nie obietnicą skuteczności; utrwalić je w manifestach benchmarków.
3. Użyć tokenizera odpowiadającego modelowi, jeśli jest dostępny. Gdy dokładne liczenie nie jest dostępne, jawnie oznaczyć estymację i stosować konserwatywny limit bajtów/rekordów jako oddzielną ochronę, bez nazywania go dokładnym limitem tokenów. Mierzyć rzeczywisty usage i koszt końcowy.
4. Agent może wyszukać i odczytać dalsze notatki oraz przejść po relacjach. Wyniki mają ID, źródło i informację o ograniczeniu/truncation. Ograniczyć pojedyncze odpowiedzi i liczbę kroków; rozszerzenie jest kolejnym widocznym tool call, a nie automatycznym pobraniem całego grafu.
5. Egzekwować scope i read/write w adapterze lub osobnym, ograniczonym procesie MCP. Aside/verifier nie zapisują autorytatywnych wspomnień; main może zapisywać w swoim zakresie. Bezpośrednie narzędzia backendu nie mogą omijać bramki przez globalny config. Jeśli konieczny proxy MCP, implementować tylko wymagane operacje, bez nowej platformy narzędzi.
6. Przetestować zarówno App Server używany przez aplikację, jak i ścieżkę SDK używaną w istniejących pomiarach. Nie uznawać implementacji ukończonej, gdy działa tylko konfiguracja MCP w jednej ścieżce. Uszanować istniejące zewnętrzne serwery i konfigurację Vex.

### 5. Capture, provenance i aktualność

1. Zapisywać już zwalidowane checkpointy/raporty oraz jawne trwałe ustalenia. Nie dodawać osobnego agenta streszczającego każdą rozmowę, nie kopiować całego transcriptu i nie zwiększać częstotliwości checkpointów dla pamięci.
2. Minimalny rekord: stabilne ID, typ decision/observation/hypothesis/procedure, project/task/role, treść, źródłowa sesja/turn/attempt, czas, opcjonalny commit/branch/pliki/symbole, status i relacje, w tym supersedes. Hipoteza nie staje się faktem przez sam zapis.
3. Krótkie nowe ustalenie agenta może powstać w obecnym wykonaniu, z mierzoną odpowiedzią/zapisem. Cel pilota to ok. 100–200 tokenów, bez dodatkowego ukrytego turna modelu. Redundantne checkpointy deduplikować według stabilnego źródła; ponowiony zapis nie tworzy kopii.
4. Nowe ustalenie użytkownika zastępuje poprzednie; aktualny kod i aktualne polecenie mają pierwszeństwo nad pamięcią. Historyczny wynik testu nie potwierdza obecnego stanu repo. Sprawdzać provenance i nie wstrzykiwać starego dowodu jako aktualnego.
5. Podłączyć undo/redo, usuwanie rozmowy/turnów i odrzucenie źródła do unieważniania lub usuwania wyłącznie odpowiednich danych pochodnych. Zachować osobno historyczne decyzje, jeśli nadal mają ważne źródło. Redo nie duplikuje zapisów; starszy, opóźniony writer nie może przywrócić superseded/retracted rekordu jako aktualnego.
6. Wynik side work nie trafia automatycznie do trwałej, zatwierdzonej pamięci; zapis po przyjęciu przez main ma właściwe źródło i status. Treść zewnętrzna w notatce pozostaje danymi, bez podnoszenia do rangi instrukcji użytkownika.
7. Zapisywać telemetrię: recall/capture/tool calls, czas, rozmiar danych, trafienia, błędy i dostępne koszty backendu. Brak telemetrii kosztu oznacza unknown, nigdy zero. Pamięć wyłączona nie uruchamia własnych procesów ani recall/capture.

### 6. Przygotować osobne repo datasetu

1. Lokalnie przygotować mały, realistyczny fikcyjny projekt z kilkoma modułami, kontrolowanymi zależnościami i sprawdzalnymi zadaniami. Normalne kod/docs i jawne wymagania muszą wystarczać do rozwiązania podstawowych zadań także agentowi bez pamięci.
2. Oddzielić wcześniejsze zadania od przyszłych zadań ocenianych. Wcześniejszy agent pracuje przez produkcyjną integrację Pace i zapisuje pamięć. Zachować prompty, źródła, model/effort/backend/version, usage, koszt oraz moment historii. Nie podawać mu przyszłych promptów, graderów ani rozwiązań.
3. Wyeksportować zamrożoną pamięć z relacjami i provenance; sprawdzić import do świeżego namespace. Korekty ręczne opisuje nowa wersja datasetu, nie ukryta poprawa wyniku. Brak odczytu kosztu przygotowania pozostaje jawny.
4. Przygotować sześć grup scenariuszy PL/EN: powrót do decyzji i relacji, ponowny podobny błąd, zmiana ustalenia, nieaktualność po zmianie kodu/brancha, niepowiązane zadanie przy licznych notatkach, izolacja projektu/roli i brak wiedzy. Dla zmian stanu użyć jawnie przypisanych snapshotów/etapów, bez przecieku przyszłej wiedzy.
5. Grupy z prywatną historyczną decyzją dostępną tylko w pamięci oznaczyć jako continuity; raportować oddzielnie od zadań rozwiązywalnych z równym dostępem do wymagań. Z góry ustalić rubric, checks, severity i dopuszczalną regresję jakości. Nie wkładać odpowiedzi wzorcowych do eksportu.
6. Publikację wykonać dopiero po ustaleniu owner/URL/public-private z User Review. Przedtem cały katalog, manifest i raport kontroli są gotowe lokalnie. Po publikacji przypiąć URL, pełny SHA projektu, wersję scenariuszy i checksum eksportu w profilu Pace. Materiały oceny pozostają poza zasięgiem agentów, także gdy projekt/dataset jest publiczny.

### 7. Dodać benchmark Memory do gotowego Benchmark Center

1. Użyć downloadera i izolacji z planu 01. Automatycznie pobrać właściwą wersję; nie wymagać URL/SHA/ścieżek w każdym uruchomieniu. A/B mają osobne working copies, sesje i pamięć. A nie widzi snapshotu ani transcriptu przygotowawczego; B importuje świeżą kopię przy każdym powtórzeniu.
2. A: obecny Pace bez nowego backendu, ze zwykłymi dokumentami/checkpointami. B: ten sam Pace plus Basic Memory i produkcyjna polityka. Oba ramiona mają ten sam commit, prompt, model i effort; kolejność jest rotowana. Późniejszy profil integration używa produkcyjnego routingu i liczy Vex oddzielnie.
3. Quick: jedna para na krótkim zadaniu. Standard: sześć scenariuszy × trzy powtórzenia × dwa ramiona, czyli 36 wykonań scenariuszy; preflight pokazuje większą liczbę etapów/wywołań. Confirm używa niezależnego zamrożonego holdoutu; liczbę powtórzeń ustalić przed runem na podstawie wariancji pilota, bez strojenia na holdoucie.
4. Dodać osobno nazwany eksperyment pełnego cyklu: wcześniejsze zadania → zapis pamięci przez B → kolejne nowe sesje A/B. Jest uzupełnieniem domyślnego seeded benchmarku i mierzy jakość capture/aktualizacji oraz cały koszt, a nie tylko użycie gotowego snapshotu.
5. Raportować bieżący koszt, osobno przygotowanie pamięci/import i pełny cykl. Amortyzacja obejmuje N różnych kolejnych zadań, nie N powtórzeń tego samego benchmarku. Wspólna historyczna praca pozostaje jawna, lecz nie jest naliczana jako dodatkowy narzut tylko pamięci. Uwzględnić failures, indeksowanie, asynchroniczne prace i naprawy; brak danych wyklucza deklarację kompletnej oszczędności.
6. Ocena: spełnione wymagania/regresje, czas przygotowania i działania, usage/cache/koszt, kategorie błędów, severity, dowody i dotknięte zachowania. Nie używać liczby plików/linii jako zakresu błędu. Osobno pokazać rozrzut/przedział niepewności adekwatny do próby. Testy nie zastępują review, a błąd krytyczny nie znika w średniej.
7. Profil Memory w panelu prowadzi do setupu, jeśli backendu brak, po czym wraca do wyboru eksperymentu. Nie używa prawdziwej bazy użytkownika. Freeze/import/readiness mają timeout, status i cancellation; interrupted write podlega bezpiecznemu resume z planu 01.

## Verification

### Warunki odbioru

- [ ] Plan 01 jest ukończony przed startem integracji; Memory korzysta z jego wspólnego runnera/panelu, bez nowej platformy benchmarkowej.
- [ ] Pierwsze `/memory` uruchamia setup; ready/disabled/unavailable/empty/incomplete zachowują odrębne zachowanie. Cancel/disable/repair zachowują wcześniejsze dane i konfigurację.
- [ ] Zwykłe npm install Pace nie pobiera backendu/runtime/modeli; `/memory` działa także poza debug buildem. `/benchmark` pozostaje debug-only.
- [ ] Projekt i role są egzekwowane poza promptem, w obu ścieżkach runnera; aside/verifier nie zapisują autorytatywnych faktów i nie ma obejścia przez bezpośredni MCP.
- [ ] Recall jest selektywny i ograniczony, graf rozwijany na żądanie, brak trafień nie uruchamia kaskady wyszukiwań. Nie ma pełnego dumpu ani automatycznego recall każdego turna.
- [ ] Capture używa istniejących wyników, ma provenance/deduplikację, nie zwiększa częstotliwości checkpointów i nie dodaje ukrytego modelu analizującego rozmowy.
- [ ] Supersedes, współbieżne zapisy, zmiana kodu, undo/redo i usunięcie źródła nie przywracają nieważnych faktów. Błąd backendu jest widoczny i nie udaje udanego zapisu.
- [ ] Osobne repo projektu i snapshot wcześniejszego agenta są gotowe i wersjonowane. Brak owner/URL jest raportowany jako konkretny blocker publikacji, nie jako gotowy remote.
- [ ] A/B korzysta z identycznego kodu/zadania/trasy, izolowanych stanów i tej samej polityki produktu; seed nie zawiera przyszłych rozwiązań. Leakage checks obejmują shell/sieć/Git i working copy.
- [ ] Quick/Standard, Confirm i pełny cykl są rozróżnione. Raport obejmuje jakość, czas, koszt, zakres błędu, failures, unknown i koszt przygotowania/amortyzację bez mieszania zadań continuity z równym dostępem do informacji.
- [ ] Wynik może wykazać brak korzyści lub regresję. Nie deklarować zerowego narzutu/oszczędności na podstawie samego recall albo jednej pary.

### Kontrole do wykonania podczas implementacji

Dodać kontrolowane testy setupu/config i adaptera oraz integracji prompt/capture. Użyć istniejących testów MCP, checkpointów, sesji i app-composition; sprawdzić równoległe projekty, role i konflikt starszego writera, nie tylko happy path jednego agenta. Nowe testy mają mockować backend/model, bez przypadkowej instalacji programu i płatnych wywołań.

Polecenia po wdrożeniu, z katalogu Pace:

```bash
npm run build
npm run benchmark:check
npm test -- tests/mcp-manager.test.tsx tests/external-mcp.test.ts tests/app-composition.test.tsx
npm test -- tests/checkpoint.test.ts tests/sessions.test.ts tests/session-revisions.test.ts tests/turn-runner-workflow.test.ts
npm test
npm run dev
npm run dev -- benchmark run memory --profile quick
```

Uruchomić dodatkowo nowe testy memory według faktycznie utworzonych ścieżek. Ręcznie sprawdzić `/memory` w debug checkout i zbudowanej instalacji npm z tymczasowym profilem/katalogiem danych; przejść pierwszy setup, cancel, pusta baza, backend niedostępny, repair i disable. W osobnej lokalnej integracji potwierdzić rzeczywiste read/write/import i izolację procesów Basic Memory, z telemetrycznym potwierdzeniem użytych providerów. Taka kontrola potwierdza integrację, nie ekonomię pamięci.

Ostatnia komenda jest live smoke i zużywa allowance, jeśli profil uruchamia model; najpierw zweryfikować preview. Standard/Confirm i pełny cykl uruchamiać dopiero po zamrożeniu danych i rubric, przez jawny Start lub kompletny profil CLI. Raport końcowy podaje wersję datasetu, backend/model/politykę, wyniki wszystkich prób, brakujące dane oraz oddzielnie dowody z testów, live integracji i eksperymentu. Hindsight pozostaje poza tym planem i nie jest warunkiem jego odbioru.

**Status zapisu planu:** zapisano handoff oparty na obecnych plikach i uzgodnionym projekcie. Nie zainstalowano backendu, nie wygenerowano/publikowano datasetu, nie wykonano komend weryfikacyjnych ani pomiarów. Po wykonaniu planu 01 executor musi ponownie przeczytać zmienione API benchmarków.
