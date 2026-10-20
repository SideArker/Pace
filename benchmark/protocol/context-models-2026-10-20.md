# Protokół benchmarku kontekstu i modeli — 2026-10-20

Protokół ustalono przed pilotem. Baza aplikacji: `f967efb48ef73a52d8f0273751a9864bae39f7a2`. Praca odbywa się na branchu `benchmark/context-models-2026-10-20` w osobnym worktree. Zachowanie produkcyjnego Pace nie jest zmieniane.

## Trasy i infrastruktura

Główny model: `gpt-6.1-sol`, effort `medium`. Pomocniczy: `gpt-6-luna`, effort `low`. Oba ID i efforty zgłoszono przez `model/list`; krótkie rzeczywiste wywołania potwierdziły dostęp. Każda próba ma niezależny wątek i własną kopię fixture. Wykonania są sekwencyjne. Harness używa źródłowego TypeScript przez `tsx` oraz produkcyjnego AppServerRunner. Nie używa starego `dist/`.

Próba infrastruktury obejmuje dwa modele i po dwie komendy w jednej turze. Surowe zdarzenia wykazały trzy żądania modelu na turę; suma odpowiada usage runnera. Pole cache writes jest obecne i wynosi zero w próbie infrastruktury. Brakujące pola w późniejszych wynikach pozostają nieznane. Reasoning jest podzbiorem outputu i nie ma osobnej dopłaty.

Harness wyłącza Vex, integracje aplikacji oraz własne automatyczne checkpointy. Ustawia wspólny limit natywnej automatycznej kompakcji na 240 000 tokenów; scenariusze mają pozostać poniżej tego limitu. Używa istniejącego logowania Codexa. Żadne prywatne ustawienia ani zapisane rozmowy Pace nie są modyfikowane. Próbki nie korzystają z historycznych poleceń na prawdziwych repozytoriach użytkownika.

## Scenariusze i macierz

Pilot A: `pilot-export` oraz `pilot-parser-ledger`, każdy w wariantach `resume`, `compact_resume`, `fresh_replay`, `fresh_checkpoint`. Pilot B: oba te scenariusze, każdy w wariantach `sol`, `luna_main`, `luna_side`. Pilot C: tylko dłuższy `pilot-parser-ledger`, autor checkpointu `checkpoint_sol` lub `checkpoint_luna`. Każdy wariant ma jedno powtórzenie.

To 16 wykonań scenariusza, 83 tury modelu i 2 wywołania natywnej kompakcji. Maksymalnie cztery dodatkowe tury mogą naprawić niepoprawny strukturalnie checkpoint. Przed każdym wariantem odtwarzane są te same pliki. Setup zawiera dwie tury bez edycji; dłuższy przypadek dodaje trzecią turę z deterministycznym rejestrem 600 historycznych ustaleń modułów. Rejestr nie nadpisuje aktywnego kontraktu. Minimalna zmierzona wielkość dłuższego kontekstu: 50 000 tokenów według ostatniego żądania modelu, a nie sumarycznego usage. Jeśli próg nie zostanie osiągnięty, próba nie jest uznana za długą i nie przechodzi dalej.

Każda próba kończy się dwiema merytorycznymi turami implementacji. Pierwsza realizuje wcześniej poznany kontrakt i korektę; druga dodaje warunek z zachowaniem poprzednich ograniczeń. `fresh_replay` przenosi tylko pary użytkownik/odpowiedź w formacie Pace, bez pełnej historii narzędzi. `fresh_checkpoint` generuje notatkę w starym wątku i przekazuje ją z pustą listą późniejszych wymian, zgodnie z produkcyjną rotacją bezpośrednio po checkpointcie. Nie przenosi całego setupu jako dodatkowego zabezpieczenia.

W B prośba o podsumowanie jest identyczna we wszystkich wariantach. Wariant side odtwarza format `askBtw`, zachowane wymiany, plan i ostatnie 24 widoczne pozycje; nie dostaje pełnego transkryptu narzędzi. Side jest wywołany po setupie, bez aktywnego zadania w locie. Nie przekazuje nowych decyzji, więc jego wyniku nie wstrzykuje się do głównego wątku. Główny Sol wykonuje obie dalsze tury. Sekwencyjny wariant side nie stanowi dowodu korzyści z równoległości.

W C zmiana modelu na autora notatki następuje przez `thread/resume`, bez dodatkowej tury przełączającej. Zapis RPC pozwala oddzielić czas konfiguracji od generowania notatki. Nie istnieje osobny raport usage dla samego RPC zmiany modelu; jego koszt nie jest arbitralnie dopisywany ani podawany jako zmierzony zero. Następny etap zaczyna nowy wątek na identycznym Sol Medium.

## Kolejność i potwierdzenie

Pilot wykonuje rodziny A, B, C w tej kolejności; w rodzinie najpierw mniejszy, następnie dłuższy przypadek. Kolejność wariantów odpowiada wyliczeniu powyżej. Po pilocie kod zostaje zamrożony. Warunek wyboru: najpierw spełniona jakość; następnie najmniejszy całkowity koszt od interwencji do końca, z czasem jako rozstrzygnięciem przy różnicy kosztu poniżej 5%.

Każda wybrana rekomendacja wymaga osobnego potwierdzenia w swojej rodzinie. Odłożone scenariusze to `holdout-dispatch` (dłuższy kontrakt wysyłki z priorytetem błędu) i `holdout-session-cache` (osobne API i zakres TTL). Nie będą wykonywane ani wykorzystywane do dostrajania przed zamrożeniem kodu. Wybrany wariant i baza otrzymają po trzy powtórzenia na obu przypadkach, z obracaną kolejnością. Pełne potwierdzenie wszystkich trzech rodzin oznacza dodatkowe 36 wykonań scenariusza. Jeśli limit allowance lub powtarzające się awarie dostępu zatrzymają pracę, raport wymieni dokładnie niewykonany zakres; nie zastąpi go testami lokalnymi.

## Kryteria jakości ustalone przed wykonaniem

1. Zachowana wcześniejsza korekta użytkownika; brak powrotu do odrzuconego clampowania lub usunięcia cache.
2. Zachowane dokładne nazwy funkcji, pól, zakresy liczbowe, harmonogramy i strefy czasowe poznane w plikach.
3. Obie tury wykonane w całości; spełniony nowy warunek bez regresji wcześniejszego kontraktu.
4. Zewnętrzne asercje przechodzą; pliki kontraktu pozostają niezmienione; diff nie zawiera niepowiązanych zmian.
5. Odpowiedzi odpowiadają dowodom; deklaracja wykonania lub zielony test agenta nie zastępuje przeglądu diffu i niezależnego sprawdzenia.
6. Podsumowanie i checkpoint ocenia się osobno: wymagania, korekty, dowody z plików, stan niedokończony, otwarte pytania i dokładne ograniczenia. Poprawny JSON nie wystarcza.

Artefakty do przeglądu otrzymują neutralne identyfikatory. Mapowanie wariantów pozostaje dostępne w surowych wynikach, więc nie jest to całkowicie ślepy ani niezależny przegląd. Ocena każdej próby wymaga uzasadnienia. Kategorie porażek: utrata ważnego kontekstu, błąd implementacji, niepełny zakres, błędne podsumowanie i awaria infrastruktury. Bez dowodu utraty kontekstu nie przypisuje się jej zwykłemu błędowi implementacji.

## Rozliczenie i zatrzymanie

Koszty są estymatami Standard API według [oficjalnego cennika OpenAI](https://developers.openai.com/api/docs/pricing), sprawdzonego 2026-10-20. Za milion tokenów Sol: zwykły input 2 USD, cached input 0,10 USD, cache write 2,50 USD, output 10 USD. Luna: odpowiednio 0,10 / 0,01 / 0,125 / 0,50 USD. Nie są to rzeczywiste opłaty ani pomiar allowance subskrypcji. Jeśli usage nie zostanie zgłoszone, koszt całkowity pozostaje nieznany, obok jawnego znanego subtotalu.

Setup jest rozliczany raz w każdym niezależnym wariancie. Raport pokazuje cały scenariusz i okres od interwencji do końca, wliczając checkpoint, poprawkę, kompakcję, odpowiedź boczną i ponowne odczyty plików. Vex nie uczestniczy w badaniu. W razie braku raportowanych cache writes ewentualna estymata zakładająca brak niezgłoszonych zapisów ma tę nazwę w danych oraz dodatkową górną granicę; nie zamienia brakującego pomiaru na zero.

Zapis następuje przed turą, po każdej turze i po każdej próbie; błędy oraz rozpoczęte nieukończone próby pozostają w wynikach. Nie ma retry całych scenariuszy. Jest najwyżej jedna poprawka niepoprawnego checkpointu. Limit usage zatrzymuje kolejne płatne wykonania natychmiast. Dwie kolejne awarie dostępu lub transportu także zatrzymują serię. Nie stosuje się fallbacku modelu ani obchodzenia limitów.
