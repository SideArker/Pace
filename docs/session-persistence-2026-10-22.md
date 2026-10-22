# Persistence: pomiar lokalny przed i po uproszczeniu, 22.10.2026

Usunięto ponowne klonowanie izolowanego baseline’u w `PaceStore.saveChanges` oraz pełne klonowanie obiektu w `reapplyChanges` przed rekurencyjnym zastąpieniem jego pól. Merge nadal kopiuje niezmienione gałęzie i pola znane tylko z dysku. Te dwie zmiany zachowują interwał autosave, liczbę zapisów, JSON normalization, rewizje, cache baseline’ów i zasady konfliktów. Osobny, późniejszy commit dotyczący retencji baseline’ów opisano na końcu.

## Metoda

Komenda: `node --expose-gc --import tsx benchmark/session-persistence.ts 12`, Node `v22.23.3`, ten sam lokalny filesystem. Jedna seria przed zmianą store/merge i jedna po niej, po 12 próbek na rozmiar. Bazowy store/merge odpowiadał `8a2c7e1`; kandydat to working tree z opisanymi dwiema zmianami. Pozostałe zmiany Vexa/UI nie są wykonywane przez ten harness.

Każda sesja ma 10, 100 lub 500 zakończonych prób. Każda próba zawiera osiem syntetycznych observations po około 7 tys. znaków oraz wynik. Próbka dopisuje progress i uruchamia dwa współbieżne `saveChanges`: główny oraz snapshot side. Są to 24 zapisy na rozmiar. Asercje sprawdzają zachowanie wszystkich prób, dopisanych observations i side answers oraz dokładną końcową rewizję 25. Harness mierzy też odczyt summary. Nie uruchamia modeli ani nie używa danych użytkownika; katalog tymczasowy jest usuwany.

## Wyniki

Wartości `przed → po`; rozmiary plików i liczba zapisów są identyczne.

| Próby / bajty sesji | Para zapisów p50, ms | Para zapisów p95, ms | CPU całej serii, ms | Czas structuredClone, ms | Wywołania structuredClone |
|---|---:|---:|---:|---:|---:|
| 10 / 635608 | 20,17 → 17,04 | 28,28 → 21,23 | 276,09 → 230,26 | 36,43 → 21,68 | 465 → 419 |
| 100 / 6326668 | 159,40 → 124,85 | 194,62 → 141,60 | 2552,80 → 1941,90 | 612,64 → 277,28 | 465 → 419 |
| 500 / 31623868 | 1011,12 → 806,06 | 1041,07 → 920,88 | 14832,51 → 11946,35 | 3875,16 → 2807,14 | 465 → 419 |

| Próby | Przyrost heap po GC, bajty | Zaobserwowany szczyt przyrostu heap, bajty | Event loop max, ms | Odczyt summary, ms |
|---|---:|---:|---:|---:|
| 10 | 16171296 → 16175600 | 38574320 → 31059400 | 16,72 → 15,26 | 4,50 → 1,85 |
| 100 | 157980184 → 157979016 | 546029632 → 653225088 | 69,66 → 45,48 | 9,38 → 10,04 |
| 500 | 781930616 → 781951216 | 2303811864 → 2207855544 | 349,44 → 257,03 | 82,13 → 74,04 |

W obu wariantach wszystkie asercje przeszły. Dla największego fixture’u p50 pary zapisów spadło o około 20%, a CPU o około 19%. To opis tej lokalnej serii; 12 próbek, syntetyczne dane, kolejność „przed, potem po”, warm filesystem i instrumentacja klonowania nie uzasadniają gwarancji przyspieszenia w produkcji. Szczyt heap jest próbkowany po parach zapisów, więc nie obejmuje każdego chwilowego maksimum.

## Pozostały koszt

Pamięć po GC praktycznie się nie zmieniła. Cache nadal utrzymuje pełne baseline’y rewizji, a `listSummaries` nadal czyta pełny plik, waliduje ledger i kopiuje jego pola. Ledger nie ma limitu 20 widocznych tur. Dalsze zmniejszanie cache lub modeli summary wymaga osobnej zmiany kontraktu: obecne baseline’y umożliwiają zapis spread snapshotów, a summary zasila m.in. decyzję o wznowieniu kolejki. Ten pomiar nie dowodzi, że usunięcie tych danych zachowałoby zachowanie aplikacji.


## Sprawdzenie po niezależnej poprawce retencji

Po powyższej parze pomiarów na branch trafił niezależny commit `1194bac` (`fix: release old session revision baselines`). Zachowano go, dodając `writable: true` do prywatnego symbolu baseline’u, aby istniejące `Object.assign` przy undo i remote mogły przenosić aktualny baseline. Cache ma teraz 32 mocno utrzymywane ostatnie baseline’y i do 2000 WeakRef, a żywy spread snapshot utrzymuje swój baseline przez symbol. Test `keeps a spread snapshot usable after many later revisions` sprawdza jego użycie po 2050 późniejszych zapisach. Nie jest to wynik dwóch optymalizacji kopiowania i nie należy przypisywać im zmiany retencji.

Ponowiono ten sam harness na połączonym kodzie; wszystkie asercje dla 10/100/500 prób przeszły. Pliki nadal miały 635608/6326668/31623868 bajtów, po 24 zapisy i 419 wywołań structuredClone. Przyrost heap po GC wyniósł odpowiednio 16196264/146484504/663525048 bajtów. To sprawdzenie odbywało się przy równoległych kontrolach projektu, dlatego jego timing nie stanowi kolejnego kontrolowanego porównania A/B. Lżejsze summary oraz dalsze ograniczenie kosztu dużego ledgeru pozostają osobną pracą wymagającą dowodu zachowania wznowień i audytu.
