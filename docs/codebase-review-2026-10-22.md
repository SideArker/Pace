# Pace — refaktor i rekomendacje, 22.10.2026

Wdrożono wyłącznie podział kodu z punktu 1. Rekomendacje z punktów 2–3 pozostają propozycjami.

Aktualizacja po dalszym przeglądzie: wdrożono wspólne retry i składanie audytu Vexa, wspólny reset UI nowej rozmowy, pełniejsze fingerprinty benchmarków z rzeczywistym provenance baseline oraz aktualizację `benchmark-TODO.md`. Zgodnie z decyzją użytkownika usunięto nieaktywne prompty, stary request i historyczne hashe migracji. Loader uzupełnia brakujące aktywne ustawienia defaults w pamięci, zachowując edycje użytkownika i plik na dysku. Ograniczono dwie zbędne kopie w persistence po [pomiarze przed i po zmianie](session-persistence-2026-10-22.md). Poniższy tekst zachowuje ustalenia pierwotnego przeglądu; propozycje zmian semantycznych z punktu 3 pozostają poza tym wdrożeniem.

## 1. Wdrożony podział

| Plik | Linie HEAD → obecnie | Wydzielone odpowiedzialności |
| --- | ---: | --- |
| `src/components/App.tsx` | 2112 → 10 | `app/`: komendy, planowanie, transcript, modele i manual routing, usage, side answers, remote, layout; osobny `ApprovalPanel` |
| `src/core/orchestrator.ts` | 912 → 640 | Decyzje i assessment, skills, clarification, plan artifacts, składanie promptów |
| `src/core/sessions.ts` | 495 → 447 | Scalanie rewizji i konflikty w `sessions-revisions.ts` |
| `src/components/ConversationMenus.tsx` | 519 → 178 | `ConversationPicker`, `CommandMenu`, typy i sortowanie konwersacji |
| `src/integrations/app-server-runner.ts` | 496 → 340 | Obsługa requestów i rozliczanie usage |
| `src/components/Composer.tsx` | 422 → 239 | Edycja tekstu i wklejanie, prezentacja i completion |
| `extensions/vscode/src/extension.ts` | 527 → 46 | Artifact tree, custom editor, HTML i skrypt webview |

Dalszy podział zmniejszył `App.tsx` z 1092 do 10 linii; controller ma 81, a widok 159 linii. Mapę modułów zawiera [README warstwy app](../src/components/app/README.md).

Zachowano dotychczasowe publiczne eksporty. `App` jest komponentem wejściowym, `useAppController` składa mniejsze moduły stanu, efektów, interakcji i akcji, a `AppView` renderuje terminal. Kolejność etapów pozostaje w `Orchestrator.turn`; nie rozbijano ich według arbitralnego limitu linii. Listy źródeł hashowanych przez benchmarki uzupełniono o moduły powstałe z przeniesienia kodu.

Liczby porównują HEAD z chwili rozpoczęcia przeglądu (`bc33578`) z wynikiem refaktoru. W czasie przerwy pojawiły się niezależne zmiany recovery, persistence i ich testów; pozostawiono je bez cofania. Dlatego cały diff względem HEAD obejmuje również zastane zmiany zachowania, które nie są wynikiem tego refaktoru.

## 2. Uproszczenia i optymalizacje — bez implementacji

- **Wspólny mechanizm decyzji Vexa.** [orchestrator-routing.ts](../src/core/orchestrator-routing.ts) i [side-answers.ts](../src/core/side-answers.ts) powtarzają retry, walidację, pomiar czasu i zapis audytu. Mały wspólny helper może usunąć duplikację, zachowując osobne role, własność sesji i obecne warunki błędów.
- **Oddzielić kompatybilność promptów od aktywnej konfiguracji.** `taskRelationRequest`, `afterPlanHandoff` i `planExecutionInstruction` nadal są eksportowane lub parsowane, ale nie sterują aktualnym wykonaniem. [Parser](../src/core/routing/routing-prompts.ts) powinien zachować odczyt starych plików, a nieaktywne pola jawnie oznaczyć jako deprecated. Ich usunięcie wymaga osobnego ustalenia kompatybilności.
- **Profilować duże sesje przed zmianą persistence.** [Autosave](../src/core/task-execution.ts) zapisuje stan co 2 s, a [store](../src/core/sessions.ts) wielokrotnie klonuje i serializuje sesję oraz przechowuje do 2000 baseline’ów. Ledger i observations rosną mimo limitu 20 widocznych tur. Możliwy koszt CPU/RAM jest hipotezą; najpierw pomiar, potem ograniczenie kopii z zachowaniem gwarancji zapisu i konfliktów.
- **Doprecyzować provenance benchmarków.** Listy hashy uwzględniają teraz wydzielony kod, lecz nadal nie obejmują całego wykonania. [task-control.ts](../benchmark/task-control.ts) zapisuje literalny baseline commit niezależnie od podanego checkoutu. Docelowo zapisywać rzeczywisty revision, wszystkie istotne zależności i profil promptów. [benchmark-TODO.md](../benchmark-TODO.md) wymaga również aktualizacji: raport kontekstu jest już w repo, a produkcyjne usage ma testy korelacji i duplikatów.

## 3. Routing, prompty i funkcje — bez implementacji

1. **P1: trwały steering i jego udział w kolejnych decyzjach.** [queue-steering.ts](../src/components/queue-steering.ts) usuwa element kolejki po potwierdzeniu wysłania, ale przechowuje treść w pamięci joba; [turn-runner.ts](../src/components/turn-runner.ts) zapisuje ją dopiero w `finally`. Restart w tym oknie może zgubić zapis instrukcji. Ponadto `recentConversation` pomija `steeringPrompts`, a assessment odbywa się przed ich dopisaniem przez UI. Propozycja: zapis instrukcji przy attempt/operacji i atomowe potwierdzenie kolejki oraz uwzględnienie steeringu w assessment i odtwarzaniu kontekstu.
2. **P1: wspólny budżet kontekstu Vexa.** [requests.ts](../src/core/vex/requests.ts) ogranicza control i assessment przez `boundedContext`, ale workflow i stage nie mają analogicznego limitu całego kontekstu, a stage otrzymuje cały handoff. Propozycja: wspólna projekcja chroniąca aktualną prośbę, ograniczenia i istotne dowody, z diagnostyką pominięć. Wpływ na jakość trzeba zmierzyć, ponieważ skracanie może zmienić decyzję.
3. **P2: wyjaśnialny assessment i koszt decyzji.** Obecny zapis zawiera ocenę, liczbę observations i ID decyzji. Dodać kryterium → dowód → brak/niepewność oraz, jeśli kontrakt providera pozwoli, usage i koszt konkretnego requestu Vexa. Zachować `unknown` przy niepełnym pomiarze; sama liczba wywołań nie opisuje kosztu ani jakości.
4. **P2: wersjonowane profile promptów i większa ewaluacja.** Zamrozić profile, dane i rubrykę przed testem; dodać niezależnie oceniane wieloturowe zadania PL/EN, restart, steering i długą historię. [Ewaluacja z 22.10](task-workflow-evaluation-2026-10-22.md) obejmuje siedem przypadków: początkowa jakość kandydata 6/7, baseline 7/7; korektę wykonano osobno, a ocena nie była niezależna ani zaślepiona. Mniej wywołań Vexa w tym badaniu oznaczało większy łączny koszt i czas Vexa. To nie uzasadnia deklaracji ogólnej poprawy jakości/oszczędności ani strojenia progów checkpointu.

## Zakres i weryfikacja

Przegląd objął UI/input i komendy, orchestrację, persistence/recovery, routing i parser promptów, Vex context, kolejkę/steering, usage, rozszerzenie VS Code oraz powiązane testy i dokumentację. Zweryfikowano historię 19–22.10; dostępne wpisy z tego zakresu dotyczą 20–22.10. Nie był to pełny audyt każdej integracji ani pomiar wydajności produkcyjnej. Lockfile’ów, wygenerowanego kodu i dużych istniejących zestawów testowych nie dzielono.

- Bazowy run po wznowieniu: **559/559 testów**.
- Porównanie AST: przy pierwszym podziale **48 deklaracji i gałęzi komend App** odpowiadało HEAD. Dalszy podział entry pointu zachował AST **34 deklaracji i 8 efektów**; dispatch różni się wyłącznie delegowaniem dwóch niezmienionych bloków do akcji sesji i compaction. Osobne porównania potwierdziły zachowanie Composer i webview.
- Testy montujące `App` obejmują komendę informacyjną, skrót planowania, resize bez zbędnego czyszczenia historii i utworzenie nowej rozmowy po planowaniu.
- Końcowe sprawdzenia: **562/562 testy aplikacji (60 plików), 2/2 testy rozszerzenia VS Code, build obu projektów, `benchmark:check` i `git diff --check` — OK**.
- Live benchmarków nie ponawiano; wnioski o modelach opierają się na istniejących raportach, kodzie i testach.
