# TODO: benchmarki routingu, kompletności i kontekstu Pace

Docelowe miejsce w repo: `benchmark/TODO.md`. Przygotowano 2026-10-21.

Cel: zbierać rzeczywiste sytuacje z pracy w Pace i na ich podstawie sprawdzać, czy routing prowadzi do poprawnego ukończenia całego zadania przy uzasadnionym koszcie. Krótka odpowiedź nie oznacza prostego rozumowania, a długi raport nie dowodzi kompletności.

To lista przyszłych pomiarów i szablon obserwacji. Nie uruchamia benchmarków ani nie zmienia polityki produktu. Checklisty pozostają otwarte, dopóki nie ma wyników i ich oceny.

## Co już zbadano

Zakończony benchmark kontekstu i modeli z 20–21 października obejmuje 16 scenariuszy pilota i 24 potwierdzenia. W badanym zakresie świeży wątek z checkpointem Sola był droższy od kontynuacji; side Luna przyniosła niewielką obserwowaną oszczędność. Nie jest to dowód opłacalności automatycznej rotacji, równoległości ani poprawności decyzji Vexa — modele i efforty były ustalone z góry.

Raport jest obecnie w osobnym worktree: `/home/SideArker/Projects/Pace-context-benchmark/benchmark/reports/context-models-2026-10-21.md`. Nie zakładać, że został przeniesiony do głównego repo. Manifest i surowe wyniki znajdują się w tamtejszym `benchmark/results/context-models-2026-10-20/` i są ignorowane przez Git. Przed kolejnym badaniem zapewnić dostęp do tych materiałów i zapisać ich lokalizację.

Badano około 16–52 tys. tokenów kontekstu, głównie wydłużonego syntetyczną historią, i dwie dalsze tury. Autorzy checkpointu, chwilowe Sol → Luna → Sol, replay i natywna kompakcja nie mają takiego samego zakresu potwierdzenia jak wybrane porównania A/B. Pełny koszt kompakcji pozostaje nieznany.

## Kolejność

1. Zweryfikować pomiar usage i rozliczanie prób.
2. Zbierać rzeczywiste przypadki; przeprowadzić benchmarki 1–3: routing, wiele tur i kompletność.
3. Badać długi kontekst i odpowiedzi boczne przed automatyzacją tych mechanizmów.
4. Chwilową zmianę głównego modelu potwierdzać dalej tylko wtedy, gdy nadal rozważamy tę opcję.

## Warunki wspólne przed uruchomieniem

- [ ] Sprawdzić i naprawić w osobnym zadaniu przypisywanie usage do aktywnej tury w produkcyjnym `src/integrations/app-server-runner.ts`. Raport wykazał opóźnione usage poprzedniej tury i podwójne naliczanie; korekta benchmarku nie oznacza naprawy produktu.
- [ ] Potwierdzić pomiar testami opóźnionych zdarzeń, duplikatów, wielu żądań w jednej turze i zmiany modelu. Błędy oraz anulowania zachowują dostępne usage. Nieznany pomiar nie jest zerem.
- [ ] Dla każdego porównania zamrozić commit, konfigurację modeli/effortów, prompty routingu, wersje narzędzi, cennik, zakres uprawnień, dane i rubrykę oceny.
- [ ] Przed wykonaniem zapisać warianty, liczbę powtórzeń, kolejność, budżet oraz kryteria sukcesu i zatrzymania. Nie dobierać korzystnych wariantów po obejrzeniu holdoutu.
- [ ] Oddzielić przypadki do strojenia od nowych zadań do potwierdzenia. Po wykorzystaniu holdoutu do strojenia przygotować kolejny.
- [ ] Utrzymać porównywalny stan plików i historię przed interwencją. Zapisać różnice historii, cache i kolejności, jeśli identyczne warunki nie są możliwe.
- [ ] Zachować wszystkie rozpoczęte próby, surowe logi, odpowiedzi, diffy, wyniki sprawdzeń i uzasadnienia ocen. Oddzielić awarie infrastruktury od błędów decyzji i wykonania.
- [ ] Oceniać wynik według niezależnie zapisanej rubryki i dowodów, nie deklaracji agenta. W miarę możliwości oddzielić oceniającego od autora wariantu i ukryć nazwy wariantów.
- [ ] Raportować jakość, korekty, koszt całej drogi do ukończenia i czas. Oddzielić koszt interwencji, późniejszej pracy oraz całości; uwzględnić checkpointy, poprawki, notatki i nieudane próby.
- [ ] Pokazać raw/cached input, output, znany subtotal i kompletność pomiaru. Kwoty API są estymatą, nie pomiarem abonamentu Codexa. Metryki Vexa raportować oddzielnie od kosztu Codexa, wraz z dodatkowym opóźnieniem.

Interpretacja intencji, trudności i potrzeby zmiany trasy należy do Vexa. Kategorie poniżej służą ludziom do zbierania i oceny przykładów; nie są słownikiem, regexami ani progami do automatycznego routingu. Confidence i probabilities są diagnostyką.

## 1. Dobór modelu i effortu

**Kiedy zapisać przypadek:** otwarta analiza trafia na Low, odpowiedzi powtarzają się mimo korekt, prosta praca dostaje kosztowną trasę albo Luna dobrze wykonuje jasno określone zadanie. Zbierać także udane przypadki.

- [ ] Zebrać zadania obejmujące zbieranie danych, porządkowanie, syntezę, diagnozę, wymagające rozumowanie i implementację. Uwzględnić krótkie pytania wymagające głębokiej analizy.
- [ ] Porównać obecny routing z proponowanymi edytowalnymi opisami modeli i effortów. Profile Luna/Sol traktować jako hipotezy.
- [ ] Rzeczywiście wykonać wybrane trasy na tych samych zadaniach. Użyć stałej trasy odniesienia, żeby oddzielić jakość wyboru od jakości wykonania.
- [ ] Ocenić poprawność, pełny zakres, liczbę istotnych korekt i koszt osiągnięcia celu. Wskazać zarówno zaniżanie trasy, jak i zbędne podnoszenie kosztu.

**Do rozstrzygnięcia:** czy nowe opisy poprawiają ukończenie zadania i jego koszt, a nie tylko częściej wybierają Sol High.

## 2. Wiele tur i trwałość workflowu

**Kiedy zapisać przypadek:** krótki follow-up zmienia prowadzącego, powraca ukończony scout, korekta planu uruchamia cały workflow od początku albo rzeczywista zmiana celu nie zostaje rozpoznana.

- [ ] Przygotować wieloturowe przypadki: kontynuacja trudnego tematu, poprawny krótki follow-up, korekta błędu, ponowiona niespełniona prośba, nowe wymaganie, pytanie boczne i zmiana celu.
- [ ] Włączyć przypadek inspirowany `5f5be5a1`: pierwsza tura Luna Medium, dziewięć kolejnych Luna Low. Odtworzyć potrzebne fakty i oczekiwany postęp; nie wymagać z góry jednej nazwy modelu jako odpowiedzi.
- [ ] Sprawdzić poprawkę planu po zakończonym scoucie oraz jawne przejście do wykonania przez `/execute`.
- [ ] Porównać obecną politykę z trwałym workflowem i decyzją sterującą Vexa, gdy implementacja kandydata będzie dostępna. Oznaczyć symulacje, jeśli produkcja nie obsługuje jeszcze danego zachowania.
- [ ] Sprawdzić rzeczywiste odpowiedzi i postęp, zmiany etapów, zbędne ponowienia scouta oraz trafność utrzymania lub zmiany trasy. Nowe wymaganie nie jest automatycznie błędem poprzedniej odpowiedzi.
- [ ] Z góry ustalić protokół kolejnych wiadomości, korekt i zakończenia próby, aby warianty miały porównywalną możliwość dojścia do celu. Nie dopasowywać pomocy użytkownika do wybranego modelu.
- [ ] Potwierdzić na nowych przypadkach i parafrazach w różnych językach.

**Do rozstrzygnięcia:** czy Pace zachowuje ciągłość pracy i reaguje na brak postępu, bez utrzymywania błędnej trasy lub eskalowania każdej kontynuacji.

## 3. Kompletność i rozpoznawanie ukończenia

**Kiedy zapisać przypadek:** raport obejmuje kilka plików mimo szerszej prośby, agent kończy po rozpoznaniu zamiast implementacji albo przedłuża już ukończoną pracę.

- [ ] Przygotować kontrolowane repo z istotnymi zależnościami w różnych miejscach i niezależną mapą wymaganego pokrycia. Oceniać znaczenie dowodów, nie liczbę przeczytanych plików.
- [ ] Dodać zadanie wymagające wykonania po scoucie, poprawny pełny wynik, wynik częściowy oraz przypadek, w którym brakuje danych i właściwe jest doprecyzowanie.
- [ ] Porównać obecną ścieżkę z proponowaną oceną domknięcia i ewentualną notatką stanu, gdy będą dostępne.
- [ ] Zmierzyć przedwczesne uznanie celu za ukończony oraz niepotrzebne przedłużanie poprawnie zakończonej pracy. Raport scouta i `turn/completed` nie są dowodem ukończenia celu.
- [ ] Sprawdzić, czy wykrycie braku prowadzi do jego uzupełnienia lub jasnego oznaczenia ograniczenia. Wliczyć koszt i czas dodatkowej oceny Vexa oraz notatek modelu.

**Do rozstrzygnięcia:** czy kontrola domknięcia zapobiega pominięciom przy akceptowalnym narzucie i bez zbędnych pętli.

## 4. Długi, realistyczny kontekst i autor checkpointu

**Kiedy zapisać przypadek:** długa sesja z odczytami narzędzi, zmianami kodu i ważnymi dawnymi ustaleniami zbliża się do dużej części okna albo po rotacji agent traci decyzję lub ponownie szuka materiału.

- [ ] Zebrać realistyczną historię narzędzi, decyzji, odrzuconych założeń i zmian plików. Nie zastępować jej samym syntetycznym wypełnieniem.
- [ ] Zmierzyć kontekst przed interwencją i udział rzeczywistego okna konkretnego modelu. Zaplanować poziomy znacznie powyżej dotychczasowych 3–11%, również w pobliżu obecnego 75%, jeśli pozwala na to budżet. To punkty pomiaru, nie nowa reguła produktu.
- [ ] Porównać kontynuację, natywną kompakcję, fresh replay i fresh checkpoint. Potwierdzić dostępność i wiarygodność pomiaru kosztu kompakcji; brak danych ujawnić.
- [ ] Obserwować więcej niż dwie dalsze merytoryczne tury. Z góry ustalić horyzont i sprawdzić, czy oraz kiedy migracja się amortyzuje, uwzględniając cache i ponowne rozpoznawanie repo.
- [ ] Porównać autorów checkpointu przy tych samych wymaganiach. Ocenić wierność dokładnych ustaleń i późniejsze wykonanie, a nie tylko walidację JSON.
- [ ] Sprawdzić przekazanie po krótkiej odpowiedzi innego modelu oraz po korekcie ważnego wymagania; nie zakładać, że ostatnia trasa jest właściwym autorem.

**Do rozstrzygnięcia:** kiedy strategia kontekstu pomaga i kto powinien przygotować przekazanie. Nowa automatyczna polityka wymaga osobnej decyzji użytkownika po wynikach.

## 5. Odpowiedzi boczne w rzeczywistej pracy

**Kiedy zapisać przypadek:** pytanie lub TL;DR pojawia się podczas pracy głównego agenta, odpowiedź boczna nie ma potrzebnego faktu albo wnosi ustalenie, które trzeba przekazać prowadzącemu.

- [ ] Porównać odpowiedź głównego agenta z osobnym agentem otrzymującym faktycznie dostępny snapshot `/btw`. Uwzględnić pytania wymagające szczegółu z historii narzędzi, którego snapshot może nie zawierać.
- [ ] Zmierzyć poprawność i reakcję na brak kontekstu, koszt bocznej odpowiedzi oraz późniejszego dokończenia głównego zadania.
- [ ] Sprawdzić pytanie podczas aktywnej pracy i rzeczywistą równoległość: czas do odpowiedzi bocznej i do zakończenia głównego zadania. Nie wyprowadzać przyspieszenia z sekwencyjnego harnessu.
- [ ] Przekazać jawnie nowe ustalenie z side do głównego zadania i sprawdzić, czy zostaje poprawnie zastosowane z zachowaniem źródła oraz aktualnego stanu pracy. Nie kopiować każdej odpowiedzi automatycznie.
- [ ] Uwzględnić pytanie oparte na snapshotcie, który zdezaktualizował się podczas pracy głównego agenta.
- [ ] Jeśli nadal rozważamy chwilowe Sol → Luna → Sol, wykonać osobne potwierdzenie na nowych zadaniach. Dotychczasowy pilot tego nie rozstrzyga.

**Do rozstrzygnięcia:** kiedy odpowiedź boczna ma wystarczający kontekst i pomaga użytkownikowi bez pogorszenia głównej pracy; osobno ocenić cenę, ciągłość i czas.

## Rejestr rzeczywistych przypadków — kopiuj przy zdarzeniu

Nie trzeba od razu uruchamiać benchmarku. Najpierw zachowaj dowody, zanim dalsze tury zmienią kontekst.

```markdown
### CASE-____ — krótka nazwa
- Status: obserwacja / gotowy do odtworzenia / w badaniu / oceniony
- Data i sesja; konkretne tury / ID wątków:
- Kategoria: 1 / 2 / 3 / 4 / 5
- Cel użytkownika i niezależny warunek ukończenia:
- Stan przed zdarzeniem: etap, ukończona praca, istotne decyzje:
- Wiadomość użytkownika i minimalny kontekst potrzebny do interpretacji:
- Faktycznie wybrany workflow, rola, model i effort:
- Decyzje Vexa i konfiguracja promptów; odnośniki do logów:
- Co agent zrobił; dowody poprawności lub braków (odpowiedź/diff/test/artefakt):
- Czy to korekta błędu, nowe wymaganie, pytanie boczne czy zmiana celu? Uzasadnienie:
- Dalszy przebieg: korekty, ponowienia i sposób ukończenia lub przyczyna zatrzymania:
- Usage/cache, czas i estymata kosztu; czego nie zmierzono:
- Commit repo i stan plików; wersje narzędzi i konfiguracja modeli:
- Hipoteza do sprawdzenia i wariant porównawczy (oddzielić od faktów):
- Rubryka jakości i sposób odtworzenia w izolowanym fixture:
- Przeznaczenie: strojenie / nowe potwierdzenie (po ujawnieniu nie wraca do holdoutu)
- Wynik badania, ograniczenia i odnośnik do raportu:
- Następny krok / osoba odpowiedzialna:
```

Przy przenoszeniu rzeczywistych rozmów do repo przygotować minimalny przykład bez sekretów i prywatnych danych. Zachować powiązanie z lokalnym źródłem; nie commitować pełnych surowych logów automatycznie.

## Istniejące narzędzia i zakończenie badania

Punktem wejścia jest `benchmark/README.md`. `benchmark:routing` sprawdza decyzje bez wykonania Codexa; `benchmark` wykonuje zadania, a `benchmark:grade` pomaga ocenić wyniki. Obecny benchmark decyzji używa m.in. symulowanych raportów etapów, więc nie dowodzi jakości scouta. Przed badaniem wieloturowym sprawdzić, czy harness obsługuje nowy protokół i trwały stan; nie zakładać, że istniejące komendy pokrywają nowe scenariusze.

- [ ] Po każdej serii dopisać raport: warianty, wszystkie próby, oceny jakości, koszty, czas, nieznane pomiary, ograniczenia i rekomendacja.
- [ ] Oddzielić wynik „wykonano poprawnie” od „oszczędniej” i „szybciej”. Małej próby nie opisywać jako gwarancji.
- [ ] Zaznaczyć, czy wynik wystarcza do decyzji, czy potrzebne jest potwierdzenie. Link do raportu wpisać przy odpowiednich punktach TODO.

Restart, kolejka, trwałość intencji, błędy zapisu, konkurencyjne snapshoty i izolacja wątków wymagają przede wszystkim testów integracyjnych. Płatny benchmark jest potrzebny do oceny semantycznych decyzji, jakości odpowiedzi i kosztu realnego wykonania; nie zastępuje tych testów.
