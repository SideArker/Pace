# Benchmark kontekstu i modeli Pace — 20–21 października 2026

Ukończono cały zaplanowany pilot (16 wariantów) i wybrane potwierdzenie A/B (24 warianty: trzy powtórzenia na dwóch odłożonych zadaniach). Wszystkie 40 wyników kodu przeszły asercje i przegląd; jedna notatka Luny nie przeszła pełnej oceny wierności. **Zachowaj główny wątek w badanym zakresie.** W sześciu parach checkpoint był droższy o 86,8% i wolniejszy o 81,2% według timera etapów. Side Luna obniżyła koszt po interwencji łącznie o 3,4%, z wygraną w 5/6 par; to mała obserwowana korzyść, bez dowodu niezawodności. Jej wynik czasowy pozostaje nierozstrzygnięty z powodu jednej rozbieżności zegarów. Nie potwierdzono na holdout chwilowego Sol/Luna/Sol, natywnej kompakcji, replay ani autora checkpointu Luna.

## Baza i odtwarzalność

Baza aplikacji: `f967efb48ef73a52d8f0273751a9864bae39f7a2`. Osobny branch `benchmark/context-models-2026-10-20`, worktree `/home/SideArker/Projects/Pace-context-benchmark`. Checkout główny pozostaje niezmieniony. Zmiany obejmują benchmark, scenariusze, testy i dokumentację; produkcyjne routing, checkpointy i `/btw` nie zostały zmienione.

Codex CLI i SDK: `0.160.0`; Node: `v22.23.3`. Główny model `gpt-6.1-sol`, effort `medium`; pomocniczy `gpt-6-luna`, effort `low`. Katalog `model/list`, rzeczywiste wywołania i metadata `thread/start/resume` potwierdzają te ID i efforty. Nie użyto fallbacku. Konkretne aliasy są stałe, ale nie udostępniono identyfikatora wag backendu. Część pilota wykonano przed przerwaniem 20 października, pozostałe warianty po wyraźnym wznowieniu 21 października; jest to dodatkowe ograniczenie pilota.

Kod potwierdzenia zamrożono w `a7970f99a4c6800ecc6c2611b4bedba31297ea71`. Początkowy pilot korzystał z `37e8c0c`; brakujące B/C z `68320ae`. Korekta pomiaru nie zmieniła odpowiedzi ani diffów. Manifest każdego wykonania zawiera hashe kodu, suite, wersje, ceny, trasy i pełną kolejność. Zbiorczy [manifest](../results/context-models-2026-10-20/manifest.json), [surowe wyniki](../results/context-models-2026-10-20/), [graded-summary.json](../results/context-models-2026-10-20/graded-summary.json) i [stages.csv](../results/context-models-2026-10-20/stages.csv) pozostają lokalnymi artefaktami.

Hashe zamrożonego potwierdzenia:

- Kod benchmarku SHA-256: `ee964aee896febaed03f076d00e7a81698406a46ddb79e2334a27b71baf2a42d`.
- Suite SHA-256: `771f7537ff6e6dc6a4873354e09b31e1dfd7acbcc6e03cf592e730e20c37af32`.
- Korektor po ID tury: `7b3b1a5e2dc551e2626d7102e409266091e9c1c8a0dbd8f39f093c9378c71277`.

Kontynuacja po przerwaniu używa osobnego supervisora z weryfikacją każdego zamrożonego pliku; nie zmienia `runCase`, tras, promptów ani kolejności. Hash supervisora zapisano w manifeście continuation.

## Zweryfikowane zachowanie Pace

`AppServerRunner` uruchamia `thread/start` bez ID albo `thread/resume` z ID. Zmiana modelu zachowuje wątek. Model i effort są przekazywane przez protokół. `checkpointDue` stosuje 16 tur lub 75% zmierzonego okna; generowanie korzysta z `session.route`, działa w starym wątku, dopuszcza jedną poprawkę i limit 10 000 znaków. Po zapisie checkpointu orchestrator może rozpocząć świeży wątek z notatką i najwyżej trzema ograniczonymi wymianami **po** źródłowej turze. Bezpośrednio po zapisaniu notatki jest ich zero — tak odtwarza to nowy harness.

`askBtw` tworzy oddzielny wątek w `side/read-only`, preferuje Luna Low i nie nadpisuje trasy ani ID głównego wątku. Kopiuje zachowane udane wymiany, bieżącą prośbę i plan, jeśli istnieją, oraz ostatnie 24 widoczne pozycje. Szczegóły pozycji activity mogą zawierać wynik komendy. To nie jest pełna historia narzędzi. Wynik side nie jest automatycznie przekazywany głównemu agentowi.

Sprawdzono historię: `ab562ff` wprowadzał reset wątku przy zmianie modelu; `f516fc2` go usuwał; `3f5c4d4` dotyczył rotacji przez checkpoint. Suite `context-real-repo.json` zaktualizowano z historycznego `ee2aaa9` do obecnej bazy. Historycznych zadań nie wykonywano na repozytoriach użytkownika. Raport z 29 września pozostał zachowany; jego liczb nie użyto jako bazy.

## Metoda i kryteria

[Protokół pilota](../protocol/context-models-2026-10-20.md) zapisano przed wykonaniem; [wybór potwierdzenia](../protocol/context-models-confirmation-2026-10-21.md) przed pierwszym holdout. Pilot: A — dwa zadania × cztery strategie; B — dwa zadania × trzy warianty; C — jedno dłuższe zadanie × dwóch autorów. To 16 scenariuszy, 83 tury modelu oraz dwie natywne kompakcje, plus ewentualne poprawki notatek. Każdy wariant kończy się dwiema merytorycznymi turami pracy po interwencji. Druga tura czasem potwierdza już zaimplementowany warunek przez sprawdzenia zamiast zbędnej edycji.

Mały pilot dotyczy eksportu z limitami, harmonogramami, korektą „RangeError zamiast trim” i priorytetem błędu archiwów. Dłuższy dotyczy parsera z wewnętrznym cache, dokładnym kontraktem pól i korektą kopiowania zarówno hit, jak i miss. Dodaje deterministyczny rejestr 600 nieaktywnych ustaleń modułów. Holdouty mają osobne API, liczby i nazwy: dispatch z limitami 12/70 i strefami UTC/Europe/Warsaw oraz cache sesji z token/ttl 1..9. Nie wykonano ich do dostrajania. Przed ich pierwszym wykonaniem poprawiono statyczną dwuznaczność zdania o nieujemnej całkowitej liczbie; asercje i rubryka pozostały takie same.

Każdy wariant ma nowy wątek początkowy i własny identyczny stan plików. Hash przed interwencją sprawdza, że setup nie edytował fixture. Historie nie są identyczne: odpowiedzi setupowe i odczyty narzędzi generowano osobno; ich rozmiary są zapisane. Nie badamy czystego efektu interwencji bez losowej zmienności odpowiedzi i cache. Kolejność wariantów w potwierdzeniu jest odwrócona w drugim powtórzeniu.

W B wyłączono automatyczne checkpointy harnessu. Side odtwarza format `askBtw`; działa po zakończonym setupie, bez aktywnej prośby w locie. Nie proszono o nową decyzję do wdrożenia, więc nie było potrzeby przekazania nowego ustalenia jako równoważnej wiadomości użytkownika. Wynik side nie trafia do głównego wątku. Nie badano równoległości; sekwencyjny czas side nie dowodzi zysku z równoległego wykonania.

Każde wykonanie sprawdzono zewnętrznymi asercjami oraz przeglądem odpowiedzi, diffu i — gdy występuje — podsumowania/notatki. Kryteria: zachowane wcześniejsze korekty, dokładne ograniczenia i API; pełen wymagany zakres; raport zgodny z dowodami; brak powrotu do odrzuconych założeń i niepowiązanych zmian. JSON `complete:true` nie jest kryterium semantycznym. Bundles do przeglądu mają neutralne ID, a `grades.json` zawiera uzasadnienia. Ocenia ten sam agent, który prowadzi wykonanie; mapowanie jest dostępne. To nie jest niezależny ani całkowicie zaślepiony przegląd.

Zmierzony kontekst **przed** interwencją, według ostatniego żądania modelu; nie jest to suma usage ani liczba wiadomości. Okno Sola wynosiło 475 000 tokenów. Dłuższe przypadki przekraczają ustalony próg 50 000 tokenów, ale pozostają daleko od 75% okna.

| Scenariusz | Tokeny min–max | Znaki odpowiedzi setupu min–max | Różne stany plików przed interwencją |
|---|---:|---:|---:|
| holdout-dispatch | 52,082–52,394 | 1,418–1,582 | 1 |
| holdout-session-cache | 15,866–16,089 | 1,002–1,252 | 1 |
| pilot-export | 16,014–16,155 | 994–1,197 | 1 |
| pilot-parser-ledger | 51,994–52,103 | 1,170–1,288 | 1 |

Jedna wartość hasha stanu dla danego scenariusza potwierdza identyczność plików. Różne długości odpowiedzi potwierdzają, że nie były to identyczne losowo wygenerowane historie. Długość zwiększa głównie syntetyczny rejestr użytkownika; nie jest to test przy granicy okna ani pełna historia pracy w dużym repozytorium.

## Poprawność pomiaru i koszty

Koszty oznaczają estymatę **Standard API**, nie opłatę za Codex ani pomiar allowance. [Oficjalny cennik OpenAI](https://developers.openai.com/api/docs/pricing), snapshot 20 października: za milion tokenów Sol input 2 USD, cached input 0,10 USD, cache write 2,50 USD, output 10 USD; Luna odpowiednio 0,10 / 0,01 / 0,125 / 0,50 USD. Reasoning jest już częścią outputu i nie jest doliczany ponownie. Żądano serviceTier=standard, ale metadata zwraca serviceTier:null; nie wyprowadzamy z tego faktycznej taryfy konta. W żadnym zmierzonym żądaniu nie przekroczono progu 272K input snapshotu short.

W surowym RPC wykryto ważny błąd początkowego rozliczenia: usage poprzedniej tury może nadejść po wysłaniu `turn/start`. Runner oraz początkowy audyt zliczały rosnące totalTokens bez rozróżnienia ID tury. Powodowało to ponowne naliczenie wcześniejszego żądania, niekiedy według modelu następnej tury. Wszystkie kwoty w tym raporcie pochodzą z rozliczenia **po ID aktywnej tury**, z deduplikacją wewnątrz tury. Zachowano oryginalne run.json; osobne accounting-corrected.json zawiera poprawione sumy, oryginalne wartości i hashe korekty. Wcześniejsze kwoty z komunikatów roboczych są zastąpione niniejszym raportem. Poprawiono harness; produkcyjny licznik wymaga osobnej decyzji/naprawy.

Natywna kompakcja zwraca dodatnie last.totalTokens, ale zerowe pola input/output. To placeholder, nie dowód darmowego wykonania. Pełny koszt wariantów compact_resume jest **nieznany**. Pokazujemy znany subtotal kolejnych etapów. Brakujący pomiar nie jest zamieniany na zero.

Setup jest rozliczany raz w każdym niezależnym scenariuszu. Koszt po interwencji obejmuje generowanie i poprawkę checkpointu, kompakcję, podsumowanie główne/boczne i obie kolejne tury Sola, wraz z ich odczytami plików i wszystkimi odrębnymi żądaniami modelu. Czas etapów obejmuje uruchomienie App Server i konfigurację wątku; osobno dostępny jest czas całego scenariusza z startedAt/finishedAt. W C czas samego thread/resume jest zapisany jako configurationDurationMs i pozostaje składnikiem etapu notatki. Nie ma odrębnego inference usage dla samego RPC zmiany modelu; nie nazywamy go zmierzonym zerowym kosztem.

Znane subtotale tokenów wszystkich rozpoczętych scenariuszy (bez czterech osobnych prób infrastruktury). Nie są to pełne sumy, ponieważ część etapów nie ma użytecznego pomiaru:

| Zwykły input | Cached input | Cache writes | Output | Reasoning (zawarty w output) | Etapy z nieznanym usage |
|---:|---:|---:|---:|---:|---:|
| 2,495,464 | 10,287,488 | 0 | 98,130 | 3,435 | 19 |

Szczegóły per etap, model, effort i wątek zawiera stages.csv. Cache writes raportowane jako zero pozostają odróżnione od brakujących pól.

## Wyniki pilota po korekcie księgowania

| Rodzina | Scenariusz | Wariant | Jakość | Cały scenariusz | Od interwencji | Czas etapów: całość / po interwencji |
|---|---|---|---|---:|---:|---:|
| A | pilot-export | compact_resume | OK | nieznany (znane $0.1208) | nieznany (znane $0.0781) | 76.9 s / 56.8 s |
| A | pilot-export | fresh_checkpoint | OK | $0.1315 | $0.0898 | 98.0 s / 78.3 s |
| A | pilot-export | fresh_replay | OK | $0.1176 | $0.0681 | 77.2 s / 52.3 s |
| A | pilot-export | resume | OK | $0.0793 | $0.0367 | 67.8 s / 44.7 s |
| A | pilot-parser-ledger | compact_resume | OK | nieznany (znane $0.2367) | nieznany (znane $0.1235) | 92.4 s / 67.7 s |
| A | pilot-parser-ledger | fresh_checkpoint | OK | $0.2092 | $0.0965 | 99.4 s / 75.2 s |
| A | pilot-parser-ledger | fresh_replay | OK | $0.2647 | $0.1515 | 77.0 s / 46.3 s |
| A | pilot-parser-ledger | resume | OK | $0.1940 | $0.0514 | 59.9 s / 38.3 s |
| B | pilot-export | luna_main | OK | $0.1000 | $0.0582 | 62.7 s / 44.7 s |
| B | pilot-export | luna_side | OK | $0.0794 | $0.0368 | 70.6 s / 48.0 s |
| B | pilot-export | sol | OK | $0.1162 | $0.0439 | 72.7 s / 53.4 s |
| B | pilot-parser-ledger | luna_main | OK | $0.2009 | $0.0882 | 107.5 s / 84.8 s |
| B | pilot-parser-ledger | luna_side | OK | $0.1830 | $0.0702 | 90.0 s / 64.2 s |
| B | pilot-parser-ledger | sol | OK | $0.1632 | $0.0500 | 65.3 s / 43.6 s |
| C | pilot-parser-ledger | checkpoint_luna | kod OK; uchybienie notatki | $0.1904 | $0.0777 | 94.5 s / 68.1 s |
| C | pilot-parser-ledger | checkpoint_sol | OK | $0.2410 | $0.0987 | 141.6 s / 114.5 s |

To pojedyncze powtórzenia. W A resume miał niższy koszt niż obie w pełni wycenione strategie świeżego wątku. Dla kompakcji już znany subtotal dalszej pracy przekraczał resume w obu przypadkach; jej pełnego kosztu nie znamy. W B tania odpowiedź Luny w głównym wątku nie przełożyła się na niższy koszt dwóch późniejszych tur i całego okresu po interwencji. Side wygrała kosztowo tylko w małym przypadku. Kod po chwilowym przełączeniu na Lunę zachował wymagania w 2/2 przypadków pilota; ten wariant nie otrzymał holdout i nie ma podstaw do ogólnego wniosku o braku regresji.

## Potwierdzenie na odłożonych zadaniach

Po ocenie jakości wybrano najtańsze poprawne alternatywy: A `fresh_checkpoint` z autorem Sol wobec `resume`; B `luna_side` wobec `sol`. Obie alternatywy były łącznie droższe od swoich baz w pilocie; wybór nie oznaczał ogłoszenia oszczędności. Plan potwierdzenia: dwie rodziny × dwa zadania × dwa warianty × trzy powtórzenia = 24 scenariusze i 126 tur modelu, plus ewentualne naprawy checkpointów. Nie dostrajano kodu ani promptów po rozpoczęciu potwierdzenia.

Ukończono 24/24 scenariuszy; brakuje 0. [Dokładna lista brakującego zakresu](../results/context-models-2026-10-20/missing-confirmation.json). W tabeli baza / alternatywa oznacza resume / fresh_checkpoint w A oraz sol / luna_side w B. Dodatnia zmiana kosztu oznacza droższą alternatywę.

| Rodzina | Scenariusz | Powtórzenie | Ocena pary | Koszt całych scenariuszy: baza / alternatywa | Koszt po interwencji: baza / alternatywa | Zmiana kosztu | Czas po interwencji: baza / alternatywa |
|---|---|---:|---|---:|---:|---:|---:|
| A | holdout-dispatch | 1 | OK | $0.1754 / $0.2079 | $0.0610 / $0.0926 | +51.8% | 50.7 s / 98.5 s |
| A | holdout-dispatch | 2 | OK | $0.2040 / $0.2100 | $0.0593 / $0.0957 | +61.3% | 47.2 s / 97.8 s |
| B | holdout-dispatch | 1 | OK | $0.2109 / $0.1856 | $0.0675 / $0.0701 | +3.9% | 73.2 s / 62.9 s |
| A | holdout-session-cache | 1 | OK | $0.0524 / $0.1242 | $0.0314 / $0.0818 | +160.3% | 51.0 s / 93.8 s |
| B | holdout-session-cache | 1 | OK | $0.0760 / $0.1031 | $0.0348 / $0.0318 | -8.5% | 58.4 s / 56.7 s |
| A | holdout-dispatch | 3 | OK | $0.2017 / $0.1843 | $0.0587 / $0.0914 | +55.7% | 56.2 s / 108.6 s |
| B | holdout-dispatch | 2 | OK | $0.1653 / $0.1638 | $0.0709 / $0.0684 | -3.6% | 71.9 s / 68.3 s |
| B | holdout-dispatch | 3 | OK | $0.1872 / $0.1795 | $0.0693 / $0.0654 | -5.7% | 71.1 s / 55.3 s |
| A | holdout-session-cache | 2 | OK | $0.0716 / $0.1195 | $0.0303 / $0.0800 | +163.9% | 55.8 s / 75.4 s |
| A | holdout-session-cache | 3 | OK | $0.0661 / $0.0973 | $0.0249 / $0.0548 | +120.1% | 46.2 s / 82.5 s |
| B | holdout-session-cache | 2 | OK | $0.0762 / $0.0548 | $0.0353 / $0.0344 | -2.4% | 54.0 s / 55.2 s |
| B | holdout-session-cache | 3 | OK | $0.0778 / $0.0524 | $0.0360 / $0.0328 | -8.6% | 62.8 s / 72.6 s |

A (fresh_checkpoint): 6 ocenionych, poprawnych i wycenionych par z 6 ukończonych par. Koszt po interwencji łącznie: baza $0.2657, alternatywa $0.4963; alternatywa wygrywa kosztowo w 0/6 par i czasowo w 0/6.

B (luna_side): 6 ocenionych, poprawnych i wycenionych par z 6 ukończonych par. Koszt po interwencji łącznie: baza $0.3137, alternatywa $0.3029; alternatywa wygrywa kosztowo w 5/6 par i czasowo w 4/6.

Potwierdzenie dotyczy tylko wskazanych par A/B. Nie potwierdza native compact, fresh replay, chwilowego przełączenia głównego wątku na Lunę ani autorstwa checkpointu przez Lunę. Trzy powtórzenia na dwóch podobnych konstrukcyjnie fixture nie wyznaczają niezawodności ani istotności statystycznej.

### Rozbieżność zegarów i ograniczenie porównania czasu

| Rodzina | Suma performance.now po interwencji: baza / alternatywa | Suma UTC po interwencji: baza / alternatywa | Pary z rozjazdem >5 s |
|---|---:|---:|---:|
| A | 307.1 s / 556.6 s | 307.4 s / 556.9 s | 0 |
| B | 391.4 s / 371.0 s | 391.7 s / 809.0 s | 1 |

W holdout-session-cache, B luna_side, powtórzenie 2, całkowity czas UTC wynosi 517,492 s, a suma etapów performance.now 79,767 s: rozjazd 437,725 s. RPC ma lukę od 10:59:41.463 do 11:07:10.659 UTC podczas followup-1. Nie ustalono, czy przyczyną było wstrzymanie hosta, korekta zegara czy inny czynnik zewnętrzny. Nie usunięto tej próby ani nie ponowiono jej wybiórczo. Koszt tokenów i wynik jakości pozostają ważne. **Czasowej korzyści side nie uznajemy za potwierdzoną.** W A nie ma analogicznego rozjazdu; raportowane spowolnienie checkpointu potwierdzają oba zegary.

Czas UTC pełnych ukończonych scenariuszy, z utworzeniem fixture i zewnętrznymi sprawdzeniami: pilot: 1355.645 s; confirmation: 2729.075 s. Nie jest to czas kalendarzowy całego zlecenia z przerwami między sesjami.

## Autor checkpointu — osobna ocena C

Obie kontynuacje zakończyły się poprawną implementacją oraz spełnieniem wcześniejszych korekt. Checkpoint Luny był krótszy i tańszy, ale dopisał w risks, że kontrakt nie ustala, czy endpoint i retries są wymaganymi właściwościami. Kontrakt i wcześniejszy setup wymagają niepustego endpoint oraz integer retries 0..3, bez wariantu opcjonalnego; kryteria przed próbą odrzucają brak pola. Oceniam to jako nieuzasadnione osłabienie pewności wymagania, a nie błąd końcowego kodu lub krytyczną utratę całego kontekstu. Kolejny Sol mimo tego wymaga obu pól. To jawny, ostrożny osąd recenzenta; [surowa notatka i odpowiedzi](../results/context-models-2026-10-20/pilot-C/pilot-parser-ledger/C/1/checkpoint_luna/) są dostępne do ponownej oceny.

Notatka Sola zachowała dokładny kontrakt, korektę obu ścieżek cache, dowody i stan bez zmian. Notatka Luny zachowała większość tych informacji, więc samo przejście walidatora nie ujawniło powyższego uchybienia. Zgodnie z regułą „jakość przed kosztem” nie wybrano jej jako optymalizacji do holdout. Nie przeprowadzono potwierdzenia rodziny C. Wyników A/B nie uznajemy za takie potwierdzenie. Jeśli tę wątpliwość uznać za nieistotną, nadal pozostaje tylko jedna para C, bez dowodu niezawodności ani równoważności autorów.

| Autor | RPC konfiguracji w etapie notatki | Notatka i poprawki | Dwie późniejsze tury Sola | Całość po interwencji | Czas po interwencji |
|---|---:|---:|---:|---:|---:|
| checkpoint_sol | 55 ms | $0.0211 | $0.0775 | $0.0987 | 114.5 s |
| checkpoint_luna | 45 ms | $0.0059 | $0.0718 | $0.0777 | 68.1 s |

RPC konfiguracji nie ma odrębnego raportowanego kosztu inference. Jego czas jest częścią etapu notatki, nie dodatkowym czasem do ponownego doliczenia. Nie było osobnej płatnej tury służącej wyłącznie przełączeniu modelu. Koszt późniejszego Sola nie musi spadać proporcjonalnie do kosztu/rozmiaru notatki; ta jedna para nie rozstrzyga przyczyny różnicy.

## Wszystkie rozpoczęte próby i weryfikacja

Pierwsza konfiguracja wyłączająca codex_apps była błędna — tworzyła sekcję MCP bez transportu. Zachowano 16 awarii przed inference. Szybka pętla nie zatrzymała się na tym błędzie; poprawiono konfigurację i warunek zatrzymania, następnie ponownie sprawdzono dostęp. Właściwy pilot zatrzymał się natychmiast na limicie usage po 12 ukończonych scenariuszach i jednej rozpoczętej nieudanej próbie. Dopiero po ponownym zleceniu użytkownika następnego dnia wykonano brakujące warianty. Nie obchodzono limitu ani nie podmieniano modeli.

Łącznie: 58 rozpoczętych wykonań scenariusza, 40 ukończonych, 39 pełnych ocen pozytywnych. W tym 16 awarii początkowej konfiguracji, 17 prób właściwego pilota (z jednym limitem), 25 rozpoczętych prób potwierdzenia. Osobno wykonano 4 tury sprawdzenia infrastruktury, o znanym koszcie $0.0737. Znany subtotal wszystkich scenariuszy: $5.9486; **pełny koszt wszystkich prób jest nieznany**. Nieznanych etapów nie wyceniono zerem.

W 74 etapach licznik runnera różni się od poprawnej sumy zdarzeń po ID tury. To błąd pomiaru, nie tyle samo błędów modelu. Jeden checkpoint Luny ma uchybienie wierności opisane osobno; dotąd nie stwierdzono błędu końcowej implementacji ani krytycznej utraty korekty w ukończonych ocenionych artefaktach.

Podczas potwierdzenia zniknął proces po przerwaniu konwersacji: dziesięć wyników było gotowych, kolejny checkpoint pozostał niekompletny. Zachowano oryginalne RPC, częściową odpowiedź oraz interruption.json i oddzielne rozliczenie. Czas zakończenia i pełny koszt tej próby są nieznane; znany subtotal setupu jest doliczony. Kontynuacja uruchamia tylko brakujące klucze planu, z weryfikacją zamrożonych hashy; nie powtarza udanych prób. To awaria ciągłości wykonania, nie błąd implementacji modelu.

Czasy, diffy i uzasadnienia ocen dla każdej próby znajdują się w run.json/accounting-corrected.json, grades.json i graded-summary.json. Nieudanych prób nie usunięto z mianownika audytu.

Znany subtotal scenariuszy i prób infrastruktury razem: **$6,022342**; pełny koszt pozostaje nieznany. W logach scenariuszy zapisano 213 żądań turn/start i dwie osobne natywne kompakcje; cztery tury infrastruktury są poza tą liczbą.

| Kategoria | Wynik przeglądu |
|---|---|
| Krytyczna utrata wcześniejszych korekt/kontekstu | 0 w 40 ukończonych wynikach |
| Błąd końcowej implementacji | 0 w 40 ukończonych wynikach |
| Niepełny zakres ukończonego wyniku | 0; nieukończone próby ujęte jako infrastruktura |
| Błędne podsumowanie B | 0 w ukończonych odpowiedziach |
| Uchybienie wierności checkpointu | 1: nieuzasadniona wątpliwość Luny, bez błędu kodu |
| Niepowiązane zmiany | 0 w ukończonych wynikach |
| Nieukończone próby infrastruktury | 18: konfiguracja 16, limit usage 1, przerwanie 1 |

Kategorie jakości dotyczą ocenionych artefaktów; brak odpowiedzi w nieukończonej próbie nie jest pozytywną oceną jakości.

Walidacja zamrożonego harnessu: `benchmark:check`, build i 61 powiązanych testów wykonania/checkpointu/kompakcji. Testy obejmują opóźnione usage poprzedniego modelu, wiele żądań i duplikaty, nieznane pola usage, placeholder kompakcji, semantykę osobnego wątku side oraz dokładną macierz 24 scenariuszy bez uruchamiania modelu w list mode. Supervisor wznowienia przeszedł dodatkowe trzy testy pomijania ukończonych prób i weryfikacji niezmienionych źródeł oraz benchmark:check. Te testy nie zastępują opisanych wyżej pomiarów live i przeglądów jakości.

## Rekomendacja i zakres wniosków

Zachowuj główny wątek przy badanych zadaniach i rozmiarach kontekstu. W pilocie i sześciu parach holdout nie było korzyści kosztowej świeżego checkpointu Sola: po interwencji koszt wzrósł z $0,265708 do $0,496333, czyli o 86,8%; wszystkie sześć par było droższych i wolniejszych. Ten wniosek dotyczy wyłącznie resume wobec checkpointu Sola i badanego zakresu kontekstu. Checkpoint zachowuje wartość jako jawny punkt odtworzenia i przeniesienia zadania, ale poprawny JSON wymaga przeglądu semantycznego. Nie ustalono progu opłacalności kompakcji ani świeżego wątku przy dużym udziale okna.

Chwilowe Sol/Luna/Sol zachowało kod w dwóch przypadkach pilota, lecz nie zostało potwierdzone na holdout. Nie należy z tego wyprowadzać niezawodności ani automatycznie przełączać modelu wyłącznie dla taniego podsumowania. Side utrzymuje niezależność głównego wątku. W sześciu poprawnych parach koszt po interwencji spadł z $0,3137304 do $0,3029466 (3,4%; wygrana w 5/6 par). To podstawa, by zachować istniejącą side Lunę do niezależnych pytań, bez obietnicy dużych oszczędności ani potwierdzonego skrócenia czasu. Nie uzasadnia przełączania głównego modelu dla samego podsumowania. Suma kosztów całych scenariuszy wyniosła odpowiednio $0,7934256 i $0,7393246, ale różnicę częściowo tworzą niezależnie generowane setupy; dla decyzji o interwencji właściwsza jest różnica 3,4%. Nie badano korzyści z równoległości ani przekazywania nowych ustaleń z side do głównej rozmowy.

Autor checkpointu ma znaczenie dla ceny i możliwej wierności notatki. Jedna para C pokazuje oszczędność, ale także opisane uchybienie Luny bez regresji końcowego kodu. Nie jest to dowód przewagi lub gorszej niezawodności całej klasy modeli. Zachowaj obecny sposób autorstwa do czasu szerszej oceny, jeśli kryterium jest pełna wierność ustaleń.

Przyszłą automatyzację routingu, progów, checkpointów i /btw należy rozpatrywać osobno. Te wyniki dotyczą małych, kontrolowanych implementacji i syntetycznie wydłużonej historii użytkownika, daleko od limitu okna. Nie obejmują złożonego repozytorium, bogatej starej historii narzędzi, długotrwałej współpracy ani interakcji automatycznego checkpointu z chwilowym przełączeniem modelu. Priorytet techniczny przed dalszą automatyzacją: osobna naprawa przypisywania usage w produkcyjnym runnerze i rozpoznawanie nieznanego kosztu native compaction.

## Komendy odtworzenia

W worktree z dostępnymi zależnościami i istniejącym logowaniem Codexa:

```bash
cd /home/SideArker/Projects/Pace-context-benchmark
npm run benchmark:context-quality -- --study --help
npm run benchmark:thread-switch -- --study --phase pilot --list
npm run benchmark:check
npm test -- tests/context-models.test.ts tests/compact.test.ts tests/checkpoint.test.ts tests/execution.test.ts
npm run build
```

Pełny nowy pilot (nowy katalog wyjściowy; nie nadpisywać zapisanych prób):

```bash
npm run benchmark:context-quality -- --study --phase pilot --out benchmark/results/reproduce-pilot
```

Rzeczywiste dokończenie wcześniejszej przerwanej serii:

```bash
npm run benchmark:thread-switch -- --study --phase pilot --family B --case pilot-parser-ledger --variants luna_main,luna_side --out benchmark/results/context-models-2026-10-20/pilot-remaining-B
npm run benchmark:context-quality -- --study --phase pilot --family C --out benchmark/results/context-models-2026-10-20/pilot-C
```

Potwierdzenie przy zamrożonym kodzie i ustalonym wyborze:

```bash
npm run benchmark:context-quality -- --study --phase confirmation --variants resume,fresh_checkpoint,sol,luna_side --repeat 3 --out benchmark/results/reproduce-confirmation
```

Po przerwaniu procesu dokończono wyłącznie brakujące próby, z zachowaniem oryginalnych numerów powtórzeń i kolejności:

```bash
./node_modules/.bin/tsx benchmark/context-models-continue.ts benchmark/results/context-models-2026-10-20/confirmation benchmark/results/context-models-2026-10-20/confirmation-continued
```

Supervisor przed uruchomieniem weryfikuje wszystkie zamrożone hashe i nie powtarza ukończonych kluczy. Pierwotne nieukończone wywołanie zachowano osobno, zamiast uznać je za wynik modelu.

Ponowne rozliczenie i zestawienie istniejących artefaktów, bez wywołań modeli:

```bash
./node_modules/.bin/tsx benchmark/context-models-reaccount.ts benchmark/results/context-models-2026-10-20
python3 benchmark/context-models-analyze.py benchmark/results/context-models-2026-10-20
python3 benchmark/context-models-summarize.py benchmark/results/context-models-2026-10-20
```

Polecenia live zużywają allowance. Każdy katalog wykonania musi być nowy. Raw JSON-RPC, odpowiedzi, final-files.json, diff.patch, sprawdzenia i grades.json umożliwiają niezależny przegląd wyników bez ponawiania płatnych prób.
