Pamięć agentów w Pace — research i rekomendacja, 2026-10-26

**Wybrałbym Basic Memory w lokalnym, kontrolowanym trybie jako pierwszy gotowy backend do pilota.** Najlepiej odpowiada na połączenie: pamięć między sesjami, powiązane notatki, wyszukiwanie na żądanie oraz brak dodatkowego generatywnego LLM przy zwykłym indeksowaniu notatek. Dla integracji wewnątrz aplikacji Node/TypeScript alternatywą jest QMD wraz z małą warstwą zapisu i aktualizacji po stronie Pace. Hindsight z providerem `none` jest trzecim sensownym wariantem, zwłaszcza gdy ważniejsze są banki pamięci i jawny budżet recall niż lekkość infrastruktury.

To rekomendacja wynikająca z architektury, dokumentacji i przeglądu ścieżek kodu. Nie jest wynikiem porównawczego uruchomienia tych backendów w Pace. Nie wykazano jeszcze, że którykolwiek zwiększa poprawność przy niezmienionym łącznym usage.

**„Agenci wiedzą więcej bez większego usage” jest możliwym wynikiem netto.** Nowa informacja musi wejść do kontekstu modelu albo zostać odnaleziona przez narzędzie. Powstaje koszt odczytu, a przy notatce pisanej przez agenta również output. Indeks może nie wykonywać płatnego inference. Bilans całego zadania pozostanie neutralny tylko wtedy, gdy pamięć zastąpi co najmniej tyle samo eksploracji, powtarzanych odczytów, podsumowań lub błędnych prób.

Zakładam, że celem jest ograniczenie zarówno tokenów używanych przez agentów Pace, jak i całkowitego kosztu dodatkowych usług. Przeniesienie ekstrakcji z Codexa do płatnego backendu jest osobną zmianą rozliczania, a nie dowodem oszczędności. Lokalny embedding lub reranker zużywa zasoby komputera, choć nie musi zużywać limitu Codexa ani płatnego API.

**Pace ma już źródła, z których można zbudować pamięć bez ponownego analizowania całych rozmów.** Przegląd objął aktualny working tree na bazie `8f4bfbc`, z istniejącymi zmianami użytkownika. Research nie modyfikował kodu aplikacji.

| Obszar Pace | Sprawdzony mechanizm | Wniosek dla integracji |
|---|---|---|
| [PaceStore](../src/core/sessions.ts) | Sesje JSON pod `~/.pace`, osobne katalogi projektów, zapisy zmian | Można eksportować kontrolowany wycinek istniejących rekordów; pamięć nie musi zastępować store |
| [durableRunner](../src/core/task-execution.ts) | Próby, role, wyniki, obserwacje i rozliczenie | Dostępne identyfikatory źródłowe; deklaracja agenta pozostaje deklaracją |
| [checkpoint](../src/core/checkpoint.ts) | Istniejąca notatka strukturalna; 16 tur lub 75% kontekstu | Indeksować już powstałą notatkę, bez zwiększania częstotliwości jej generowania |
| [prepareRunnerPrompt](../src/core/orchestrator-prompts.ts) | Wybór resume albo nowego threada z checkpointem | Najbardziej naturalne miejsce na ograniczony pakiet przypomnienia przy nowym zadaniu/threadzie |
| [retainedConversationPrompt](../src/core/orchestrator-helpers.ts) | Odtwarzanie zachowanych wymian przy braku threada | Pamięć może zastępować redundancję, ale nie może zgubić bieżącego kontraktu i steeringu |
| [buildAsidePrompt](../src/core/side-answers.ts) | Ograniczony snapshot dla oddzielnego agenta | Osobny budżet recall dla roli; nie kopiować całej pamięci do każdego agenta |
| [codex-cli](../src/integrations/codex-cli.ts) | MCP i jego konfiguracja należą do Codexa | Istnieje droga integracji z backendami MCP; plugin do TUI Codexa nie dowodzi działania w Pace |
| [AppServerRunner](../src/integrations/app-server-runner.ts) | Proces App Server jest zamykany po wykonaniu | Indeks i daemon powinny przeżyć pojedynczy turn; zadania w tle wymagają sprawdzenia cyklu życia |
| [session-model](../src/core/session-model.ts) | Undo, usuwanie i rewind unieważniają część lokalnego stanu | Pamięć pochodna potrzebuje powiązań do źródeł i zasad unieważniania |
| [Vex projection](../src/core/vex/context.ts) | Oddzielny limit 22 000 bajtów payloadu | Nie jest to limit tokenów agenta; nie wysyłać automatycznie całej pamięci również do routera |

Obecne `projectKey` zależy od ścieżki. Integracja pamięci powinna jawnie obsłużyć przeniesienie repozytorium. Nie należy utożsamiać katalogu projektu, sesji, zadania i brancha. Stan z brancha, który nie trafił do głównej historii, nie może bezwarunkowo stać się regułą całego projektu.

**Porównanie obejmuje różne sposoby działania i ich tańsze konfiguracje.** Kolejność oznacza dopasowanie do tego celu w Pace, a nie ogólny ranking jakości pamięci. Nie przyznaję pozornie dokładnych punktów za niemierzone właściwości.

| Kandydat | Zapis i odczyt w istotnym wariancie | Dodatkowe generatywne inference | Dopasowanie do Pace |
|---|---|---|---|
| Basic Memory lokalnie | Markdown, parser obserwacji/relacji, SQLite, FTS i lokalne wektory; odczyt notatek i grafu | Zwykły parser/index nie wymaga ekstraktora LLM; napisanie notatki przez agenta nadal kosztuje | Najlepszy gotowy kompromis dla powiązanych notatek |
| QMD + zapis po stronie Pace | Wyszukiwanie istniejących plików; `searchLex`, opcjonalne wektory i reranking | `searchLex` bez LLM; pełny search może używać lokalnej ekspansji i rerankera | Najlepsza alternatywa biblioteczna dla Node; lifecycle pamięci trzeba dostarczyć |
| Hindsight `LLM_PROVIDER=none` | Surowe chunki, lokalne embeddingi/reranker, recall z limitem | Wymusza chunks i wyłącza observations/consolidation; reflect niedostępny | Dobry wariant bez ekstraktora, ale większy stos usług i danych |
| Hindsight domyślnie | Ekstrakcja faktów i powiązań, automatyczna konsolidacja, recall/reflect | Ekstrakcja i konsolidacja; reflect to kolejne rozumowanie | Warto rozważyć przy udowodnionej korzyści bogatszych doświadczeń |
| Mem0 OSS | Domyślnie ekstrakcja/uzgadnianie pamięci; `infer=false` pozwala zapisać gotową treść | `infer=false` pomija ekstrakcję; embedding pozostaje; provider może być lokalny lub płatny | Sensowna opcja dla aplikacji, która już ma Mem0; mniejsza przewaga dla notatek z linkami |
| Supermemory | Zarządzana usługa API/MCP, profile, aktualizacja i wyszukiwanie pamięci | Koszt backendu rozliczany przez usługę; dodatkowo kontekst agenta | Najprostszy kandydat managed, gdy akceptujemy usługę i jej koszt |
| Graphiti | Ekstrakcja encji/relacji i ich zmian; wyszukiwanie grafowe i semantyczne | Normalny ingestion wykorzystuje LLM; provider i reranking są konfigurowalne | Mocny przy relacjach temporalnych, cięższy od potrzeb prostego rejestru decyzji |
| Cognee | Pipeline danych i budowy grafu; wyszukiwanie nad przygotowaną wiedzą | Przejrzana ścieżka ekstrakcji grafu wywołuje LLM; możliwe różne konfiguracje modeli | Bardziej pasuje do większej warstwy wiedzy niż pierwszego małego dodatku do Pace |
| OpenViking | Hierarchia L0/L1/L2, nawigacja i ekstrakcja doświadczeń z sesji | Generowanie warstw semantycznych i ekstrakcja pamięci korzystają z modeli | Dobre wzorce ograniczania odczytu, lecz przygotowanie kontekstu ma własny koszt |
| Letta / Letta Code | Pamięć i jej filesystem są częścią stateful harnessu | Pisanie pamięci przez agenta i opcjonalne dreaming | Większy zakres zmiany wobec obecnego klienta App Server |
| Natywna pamięć Codexa | Ekstrakcja i konsolidacja z kwalifikujących się sesji | Praca modeli w tle | Ważny baseline; brak potwierdzenia pełnej integracji i bilansu kosztu dla Pace |
| Istniejące pliki + wyszukiwanie tekstowe | Własne notatki lub dokumentacja, bez nowego backendu | Brak osobnego ekstraktora | Obowiązkowy prosty baseline: pozwala ustalić, co faktycznie wnosi zależność |

Źródła implementacyjne dla tabeli: [Basic Memory parser](https://github.com/basicmachines-co/basic-memory/blob/9643ec25918e8958629a668e3ce928981ab3ea36/src/basic_memory/markdown/entity_parser.py), [QMD SDK](https://github.com/tobi/qmd/blob/v2.8.3/src/index.ts), [Hindsight config](https://github.com/vectorize-io/hindsight/blob/v1.1.0/hindsight-api-slim/hindsight_api/config.py), [Mem0 add](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/mem0/memory/main.py), [Graphiti ingestion](https://github.com/getzep/graphiti/blob/5c27edfa8d3e0f49b2571bcebb4261bcc89ee037/graphiti_core/graphiti.py), [Cognee extraction](https://github.com/topoteretes/cognee/blob/37f788bd287750e10d7610173e5332b3843f6ebd/cognee/infrastructure/llm/extraction/knowledge_graph/extract_content_graph.py), [OpenViking extraction](https://github.com/volcengine/OpenViking/blob/5c066d97094d713238c483c10691d7b4e1cfbf6e/openviking/session/memory/extract_loop.py), [Letta Code](https://github.com/letta-ai/letta-code/blob/1fb6ea4d30942ef9220b096ba7f4185f18184fc1/README.md).

**Basic Memory ma konkretne cechy przydatne dla tego zastosowania.** Treść można zachować jako pliki i zindeksować bez drugiego generatywnego czytelnika. Agent może przejść od wyszukanej notatki do jej relacji. `build_context` ma `depth`, `max_related` i `compact`; tryb compact pomija treści oraz listy obserwacji, pozostawiając dane do nawigacji. Notatki do odczytu można wybrać osobno. [Kod v0.24.1](https://github.com/basicmachines-co/basic-memory/blob/v0.24.1/src/basic_memory/mcp/tools/build_context.py).

Istotne ograniczenia: compact nie gwarantuje liczby tokenów, domyślne okno czasu grafu wynosi 7 dni, a domyślne wyniki nie są automatycznie minimalne. Dla trwałej decyzji trzeba świadomie wybrać zakres czasu, tak aby stara notatka nie zniknęła z wyszukiwania tylko przez wiek. [Referencja narzędzi](https://docs.basicmemory.com/reference/mcp-tools-reference).

W przejrzanym snapshotcie parser korzysta z MarkdownIt i jawnych obserwacji/relacji. Domyślny provider embeddingów to lokalny FastEmbed, model `bge-small-en-v1.5`, a reranker jest wyłączony. Dla mieszanego korpusu PL/EN należy zmierzyć trafność i rozważyć model wielojęzyczny. W aktualnym kodzie dostępność wyszukiwania semantycznego wynika z możliwości runtime; nie zakładam, że starsza opisana w sieci flaga wyłączająca semantykę nadal działa. [Konfiguracja](https://github.com/basicmachines-co/basic-memory/blob/9643ec25918e8958629a668e3ce928981ab3ea36/src/basic_memory/config_models.py), [runtime](https://github.com/basicmachines-co/basic-memory/blob/9643ec25918e8958629a668e3ce928981ab3ea36/src/basic_memory/repository/semantic_runtime.py).

Basic Memory wymaga dodatkowego procesu Python. Przejrzany pyproject wymaga Python 3.12+, a README opisuje także zależność od wydania prerelease FastMCP. Licencja pakietu to AGPL-3.0-or-later; nie utożsamiam jej z licencją MIT Pace. Przed dystrybucją trzeba osobno wybrać model integracji. Są to konkretne koszty utrzymania, dlatego Basic Memory nie wygrywa bezwarunkowo z prostym indeksem w aplikacji.

**QMD jest mocnym kandydatem wtedy, gdy priorytetem jest kontrola wewnątrz Pace.** W v2.8.3 istnieje biblioteczne `searchLex`, osobne wyszukiwanie wektorowe i odczyt źródeł. W przejrzanym HEAD `query` w MCP domyślnie uruchamia ekspansję/reranking, natomiast gotowe zapytania typowane pozwalają sterować ścieżką. To istotna różnica wobec założenia, że każde użycie QMD jest zwykłym tanim FTS. [SDK wydania](https://github.com/tobi/qmd/blob/v2.8.3/src/index.ts), [MCP snapshot](https://github.com/tobi/qmd/blob/86d2365d17fc682e491c2c53d1e4a884aee8682a/src/mcp/server.ts).

Zaletami są TypeScript i MIT. Ograniczeniami: Node 22+ wobec deklarowanego Node 20+ Pace, natywne zależności oraz lokalne modele w pełnym trybie. QMD nie dostarcza gotowej polityki aktualności ustaleń, unieważniania po undo ani semantyki zapisu decyzji. Dlatego określam go jako silnik odczytu dla pamięci zarządzanej przez Pace, nie kompletny zamiennik Basic Memory. [package.json v2.8.3](https://github.com/tobi/qmd/blob/v2.8.3/package.json).

**Hindsight jest lepszym kandydatem kosztowym, niż sugeruje samo domyślne zachowanie.** W sprawdzonym v1.1.0 provider `none` wymusza tryb `chunks`, wyłącza observations/consolidation i blokuje reflect. Domyślne embeddingi i reranker są lokalne. To pozwala zbudować wariant bez generatywnego backendu, który nadal umie wyszukiwać zachowane treści. Traci przy tym metadane i relacje, które normalnie wyciąga LLM. Użyteczności takiego wariantu nie wolno przypisywać wyników benchmarku pełnego Hindsight. [Kod konfiguracji wydania](https://github.com/vectorize-io/hindsight/blob/v1.1.0/hindsight-api-slim/hindsight_api/config.py).

Samo ustawienie `chunks` nie jest równoznaczne z wyłączeniem wszystkich zadań w tle. W zwykłej konfiguracji konsolidacja jest automatyczna. Należy kontrolować provider, zaplanowane zadania i embedding/reranker, a nie tylko ekstrakcję. Recall ma niezależne parametry głębokości wyszukiwania oraz rozmiaru wyniku: głęboka eksploracja nie musi oznaczać dużego pakietu dla agenta. Jest to dobry mechanizm, ale większa infrastruktura niż SQLite i notatki: Hindsight używa również PostgreSQL, z opcją embedded `pg0`. [Recall](https://hindsight.vectorize.io/1.0/developer/retrieval), [konfiguracja](https://hindsight.vectorize.io/developer/configuration).

**Mem0 ma przydatny wariant `infer=false`, lecz nie eliminuje on wszystkich kosztów.** W Python OSS pomija ekstrakcję LLM, ale nadal generuje embedding treści. Nie daje przy tym automatycznego uzgadniania faktów normalnej ścieżki `infer=true`. Domyślna konfiguracja TypeScript OSS używa OpenAI do LLM i embeddingów, a wektorowy magazyn w pamięci procesu nie jest trwałym magazynem między restartami. Zapis historii SQLite nie jest dowodem trwałości wektorów. Wybór providerów i storage jest więc częścią integracji, nie drobnym szczegółem instalacji. [Python add](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/mem0/memory/main.py), [TS defaults](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/mem0-ts/src/oss/src/config/defaults.ts).

**Supermemory pozostaje sensowną opcją managed.** Gotowy MCP umożliwia przechowywanie i odszukiwanie wiedzy w przestrzeniach projektowych. Cennik sprawdzony podczas researchu podaje dla tekstowej pamięci 5 USD za milion SM tokens, a dla search/traversal 5 USD za milion zapytań; usługa osobno mierzy niektóre operacje. Są to jednostki i opłaty Supermemory, a nie tokeny kontekstu Codexa. Przy ocenie neutralności kosztowej należy doliczyć oba systemy. Nie przeprowadziłem audytu wewnętrznej implementacji usługi managed. [MCP](https://supermemory.ai/mcp/), [cennik](https://supermemory.ai/pricing/).

Graphiti, Cognee i OpenViking mogą działać z lokalnymi providerami. Nie zakładam więc, że zawsze wymagają zewnętrznych opłat za LLM. Przejrzane normalne ścieżki wykonują jednak generatywną ekstrakcję lub podsumowania. OpenViking dodatkowo przygotowuje warstwy abstraktów i przeglądów; ich krótszy odczyt trzeba zestawić z kosztem przygotowania i aktualizacji. Ich przewaga rośnie przy dużej, współdzielonej wiedzy i istotnych relacjach. Nie wykazano jej dla lekkiej pamięci decyzji Pace.

Natywna pamięć Codexa jest wyłączona w sprawdzonej lokalnej konfiguracji CLI 0.160.0 (`features list`: memories stable false). Oficjalna dokumentacja opisuje ekstrakcję i konsolidację w tle, więc nie jest to wariant bez dodatkowej pracy modeli. Działanie dla sesji utworzonych przez Pace oraz jego krótkotrwałego App Server pozostaje do sprawdzenia. [OpenAI Docs: Memories](https://learn.chatgpt.com/docs/customization/memories).

**Wyniki badań uzasadniają ostrożną selekcję kontekstu, a nie jednego uniwersalnego zwycięzcę.** W tabeli 4 SWE-ContextBench na 99 zadaniach wariant bez wcześniejszego kontekstu osiąga 26,26% rozwiązanych zadań, samodzielny wybór podsumowań 22,22%, a podsumowanie wskazane przez oracle 34,34%. OpenViking i Supermemory raportują odpowiednio 29,20% i 30,30%, przy mniejszych raportowanych kosztach niż baseline. Oracle nie jest realistycznym retrieverem; koszty i wynik konkretnej konfiguracji nie gwarantują pełnego cyklu życia aktualnej wersji systemu. [Publikacja](https://arxiv.org/html/2602.08316v3).

MemDev-Bench pokazuje zarówno korzyści pamięci, jak i regresje wskutek użycia niepasującego doświadczenia. Ograniczenie do jednego agent–model setupu utrudnia przenoszenie rankingu do Pace. MemoryTax wskazuje możliwość przewagi wyszukiwania surowej historii nad wcześniejszą ekstrakcją, ale opiera się na jednej rozmowie, pojedynczych wykonaniach i nierównym dostępie do podpisów zdjęć. [MemDev-Bench](https://arxiv.org/html/2610.27524v1), [MemoryTax](https://arxiv.org/html/2610.29823v1).

Basic Memory i QMD nie zostały w tym researchu porównane eksperymentalnie z pozostałymi na jednakowych zadaniach Pace. Ich rekomendacja opiera się na mniejszej ilości wymaganej pracy modeli i pasujących mechanizmach odczytu, a nie na udowodnionej przewadze w rozwiązywaniu zadań.

**Istniejący benchmark Pace odpowiada na węższe pytanie.** Ponowne zsumowanie skorygowanych rekordów sześciu par A daje poniższe wartości od interwencji do końca dwóch dalszych tur. Obejmuje wygenerowanie checkpointu.

| Pomiar | resume | fresh_checkpoint |
|---|---:|---:|
| Input łącznie z cache | 1 406 709 | 899 665 |
| Cached input | 1 388 800 | 787 072 |
| Output | 9 101 | 19 244 |
| Koszt API equivalent | 0,265708 USD | 0,4963332 USD |

Input spadł o około 36%, a estymowany koszt wzrósł o 86,8%. Sześć par ma zapisaną pozytywną ocenę jakości; w tym researchu nie oceniano ponownie kodu fixture i nie uruchamiano modeli. Badanie obejmuje dwa scenariusze, trzy powtórzenia i krótki horyzont. Nie testuje pamięci zewnętrznej i nie może jej wykluczać. [Raport](../benchmark/reports/context-models-2026-10-21.md), [wyniki](../benchmark/results/context-models-2026-10-20/graded-summary.json).

**Proponowany kompromis: backend notatek oraz mała polityka odczytu w Pace.** Samo podłączenie MCP udostępnia możliwości; nie określa, kiedy agent ma je wywołać, ile pobrać i jakie rekordy są aktualne.

```mermaid
flowchart LR
    A[Istniejące decyzje i checkpointy] --> B[Zapis z identyfikatorem źródła]
    B --> C[Basic Memory: notatki i lokalny indeks]
    D[Nowe zadanie lub nowy thread] --> E[Wyszukanie w obrębie projektu]
    C --> E
    E --> F[Mały pakiet trafnych ustaleń]
    F --> G[Agent Pace]
    G --> H[Odczyt potrzebnego źródła lub relacji]
    H --> C
```

Pierwszy odczyt może wykonać Pace przez API/CLI backendu przed wywołaniem modelu. Oszczędza to osobny krok agenta polegający na wyborze narzędzia. Nie oszczędza automatycznie tokenów wstrzykniętej treści. Taki kontrolowany odczyt powinien korzystać z już znanego zadania, jego identyfikatorów oraz promptu, bez nowego klasyfikatora LLM.

W istniejącym threadzie nie dodawałbym tego samego pakietu przy każdym turnie. Powtórny odczyt ma uzasadnienie przy nowym zadaniu, nowej wersji istotnego ustalenia albo jawnym pytaniu o historię. Bieżące wiadomości i wymagania użytkownika zachowują pierwszeństwo. Pamięć nie zastępuje obowiązkowych instrukcji projektu.

Dane dynamiczne należy dopisywać w aktualnej wiadomości lub wyniku narzędzia, zachowując wcześniejszą historię. Przebudowywanie stałych instrukcji i katalogu narzędzi co turę może pogarszać cache. Oficjalna konfiguracja Codexa dokumentuje allowlistę narzędzi MCP i limity outputu, ale działanie konkretnych pól trzeba zweryfikować w przypiętej wersji Pace; w razie różnic adapter backendu może sam ograniczać odpowiedź. [OpenAI Docs: konfiguracja](https://learn.chatgpt.com/docs/config-file/config-reference), [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

**Zapis nie powinien oznaczać drugiego pełnego przeglądu rozmowy.** Już istniejący checkpoint można deterministycznie zamienić na notatkę epizodyczną z linkiem do sesji. Jawne ustalenie użytkownika można zachować w oryginalnym brzmieniu. To nie wymaga kolejnego modelu. Nie ma jednak podstaw, żeby automatycznie uznać wszystkie findings checkpointu za prawdziwe albo jego constraints za reguły następnych zadań. Nowa zwięzła notatka wygenerowana przez agenta dodaje output i musi być liczona jako koszt.

Do pamięci trwałej nadają się decyzje z uzasadnieniem, ograniczenia zakresu ich stosowania, odkryte pułapki i sprawdzone procedury. Rozbudowane logi i stare pliki mogą pozostać źródłami do odczytu. Nie kopiowałbym całej rozmowy do pamięci dla każdego turna. Nie zwiększałbym częstotliwości checkpointów po to, żeby ją zasilać.

Minimalna notatka powinna mieć: stabilne ID, zakres projektu/zadania/roli, treść, typ (`decision`, `observation`, `hypothesis`, `procedure`), źródło, czas, opcjonalne wiązania do plików/symboli oraz status. `supersedes` pozwala wskazać zastępującą decyzję. Wynik testu jest historyczną obserwacją dla danego stanu plików. Po zmianie repozytorium aktualność dowodu wymaga ponownego sprawdzenia.

**Budżety poniżej są parametrami pilota, nie wynikami pomiaru.**

| Czynność | Punkt startowy |
|---|---|
| Odczyt przy rozpoczęciu zadania | Do 600–1000 tokenów dodatkowej pamięci, jeśli są dopasowania |
| Wyniki wyszukiwania | 3–5 kandydatów z krótkimi opisami i źródłami |
| Graf | Głębokość 1; dalszy krok dopiero przy konkretnej potrzebie |
| Odczyt treści | Maksymalnie 1–2 wybrane notatki w pierwszym kroku |
| Dodatkowa notatka agenta | Około 100–200 tokenów i tylko po nowym trwałym ustaleniu |
| Brak trafnego kontekstu | Brak pakietu pamięci, bez wymuszania kolejnych wyszukiwań |
| Rozszerzenie ponad budżet | Jawny kolejny odczyt, z zachowanym źródłem i informacją o pominięciu |

Limit liczby rekordów nie jest limitem tokenów. Tokenizer powinien odpowiadać modelowi, a pomiar końcowy korzystać z rzeczywistego usage. Nie przeliczać znaków lub limitu bajtów Vex na rzekomo dokładne tokeny. Pakiet pamięci powinien usuwać powtórzenia i zastępować redundantne summary; nie może wypierać oryginalnego żądania, aktywnych constraints ani dostarczonego steeringu.

Poglądowy bilans, nie benchmark: jeśli zapis 150 tokenów, przypomnienie 700 tokenów i dodatkowe kroki narzędzi kosztują mniej niż uniknięte 2000 tokenów eksploracji, istnieje przestrzeń na oszczędność. Historia może jednak powracać w następnych wywołaniach, a cache i output mają różne stawki. Prosty rachunek jednego promptu nie dowodzi oszczędności całej sesji.

**Integracja musi zachować własność danych.** Każdy odczyt musi wskazywać projekt jawnie. Nie polegać na globalnym „aktywnym projekcie” backendu, gdy Pace ma kilka rozmów równocześnie. Agent aside/verifier powinien mieć odczyt zgodny z rolą; sandbox plików `read-only` nie ogranicza sam z siebie operacji zdalnego serwera pamięci. Prawo zapisu trzeba egzekwować w adapterze albo po stronie backendu.

Undo, usunięcie rozmowy i porzucony branch wymagają rozróżnienia: wycofany postęp nie może wrócić jako aktualny fakt, ale historyczna decyzja może być nadal potrzebna do wyjaśnienia zdarzeń. Powiązanie źródłowe umożliwia zmianę statusu lub usunięcie właściwych danych pochodnych. Współdzielony zapis potrzebuje ochrony przed nadpisaniem nowej wersji przez starszego agenta. Pamięć wygenerowana z treści zewnętrznej nie staje się przez to instrukcją użytkownika.

**Wybór zmieniłbym przy konkretnych wymaganiach.**

| Dominujący priorytet | Preferowany kierunek |
|---|---|
| Gotowe powiązane notatki, lokalnie, bez osobnego ekstraktora LLM | Basic Memory z kontrolą odczytu w Pace |
| Biblioteka Node, MIT, możliwość utrzymania niewielkiej własnej warstwy pamięci | QMD; przy małym korpusie najpierw porównać z prostym FTS |
| Banki pamięci, większy serwis, limit tokenów recall i brak generatywnej ekstrakcji | Hindsight provider `none` |
| Automatyczna ekstrakcja doświadczeń i akceptacja dodatkowego kosztu modeli | Pełny Hindsight lub Mem0 |
| Gotowa usługa, minimum obsługi infrastruktury | Supermemory |
| Złożone relacje zmieniające się w czasie | Graphiti; osobno zmierzyć ingestion i retrieval |
| Hierarchiczna wiedza obejmująca wiele dużych zasobów | OpenViking / Cognee |

**Warunek przyjęcia rozwiązania powinien odpowiadać celowi użytkownika.** Potrzebne są dwa niezależne wyniki: jakość co najmniej nie gorsza od obecnego Pace oraz koszt/usage całego cyklu nie większy. Oszczędność w jednym zadaniu nie kompensuje przemilczanej regresji w innym.

Proponowany zakres pilota obejmuje sekwencje powiązanych zadań w ewoluującym repozytorium, a nie sam quiz pamięci. Wspólne dla wariantów: model i effort, routing, stan plików, limity narzędzi i warunki cache. Pamięć zawiera tylko informacje sprzed ocenianego zadania. Potrzebny jest również wariant bez nowej pamięci i prosty plikowy baseline; porównanie wyłącznie z pełnym replay może zawyżyć korzyść.

| Przypadek | Co musi wykazać ocena |
|---|---|
| Nowa sesja w znanym module | Mniej ponownej eksploracji przy zachowaniu poprawności |
| Ustalenie zmienione przez użytkownika | Nowa decyzja ma pierwszeństwo; stara pozostaje oznaczona historycznie |
| Zmiana implementacji po dawnym teście | Agent nie traktuje starego wyniku jako aktualnego dowodu |
| Niezależne krótkie zadanie | Brak niepotrzebnego recall i kosztu pamięci |
| Dwa projekty / dwa branche | Brak przecieku ustaleń poza zakres |
| Kilka agentów | Odpowiednie role, brak utraconych aktualizacji i duplikacji pełnych pakietów |
| Undo lub usunięcie źródła | Pochodna pamięć ma właściwy status lub jest usunięta |
| PL/EN i nazwy symboli | Wyszukiwanie trafia mimo parafraz, a nie wyłącznie przy idealnym słowie kluczowym |

Raportować oddzielnie: zwykły input, cached input, cache writes, output (bez podwójnego doliczania reasoning), koszt modelu, dodatkowy backend, embeddings/reranking, czas, rozmiar odczytu i błędy spowodowane pamięcią. Wliczać budowę indeksu, konsolidację, retry, nieudane wyszukiwania oraz późniejszą reindeksację. Jakość powinna wynikać z kryteriów zadania i rzeczywistych sprawdzeń. Subskrypcyjnego allowance Codexa nie wyprowadzać z estymaty cen API.

**Zebrane dowody i granice pokrycia są jawne.**

| Przedmiot | Faktycznie sprawdzone ścieżki | Pozostawione poza oceną |
|---|---|---|
| Basic Memory | Parser Markdown, create entity/write, search, build_context, konfiguracja i runtime semantyczny; kluczowe mechanizmy także w v0.24.1 | Uruchomienie MCP w Pace, pomiar trafności, RSS/latency, pełna synchronizacja cloud |
| QMD | SDK, FTS vs hybrid, MCP query i snippets, odczyt dokumentów, runtime i package; SDK/package także v2.8.3 | Pełna implementacja własnego lifecycle, benchmark CPU/Windows, skuteczność polskich embeddings |
| Hindsight | Ekstrakcja facts/chunks, recall PostgreSQL, konfiguracja LLM/observations i lokalnych modeli; tryb none także w v1.1.0 | Uruchomienie serwisu i telemetryczne potwierdzenie braku wywołań zewnętrznych, jakość chunks vs full |
| Mem0 | Python infer false/true, embeddings i search flow, TS defaults oraz dokumentacja operacji | Parzystość wszystkich opcji Python/TS, live backend i usługa managed |
| Graphiti | add_episode, ekstrakcja encji/relacji, search, zależności | Cały graf temporalny i koszt każdej ścieżki pod obciążeniem |
| Cognee | cognify i generatywna ekstrakcja grafu, zależności | Wszystkie alternatywne pipeline i strojenie retrievera |
| OpenViking | Warstwy kontekstu, extraction loop, semantic processor, zależności i opis integracji | Live plugin w Pace i koszt każdej aktualizacji drzewa |
| Letta Code | Model harnessu, filesystem pamięci, constraints i zależności; dokumentacja dreaming z wcześniejszego etapu | Migracja Pace na inny harness, pomiar dreaming i backend Letta |
| Supermemory | Aktualny publiczny MCP i cennik | Wewnętrzny kod usługi, live recall, pełny rachunek i telemetryczne metryki |
| Codex i Pace | Oficjalne ustawienia pamięci/MCP, lokalne features, opisane wyżej źródła i przeliczenie benchmarku | Runtime pamięci natywnej w App Server, quota subscription i cała infrastruktura Codexa |

Nie zainstalowano backendów, nie zmieniono konfiguracji Codexa ani MCP, nie wysłano danych projektu do dostawcy pamięci i nie wykonano płatnych prób modeli. Nie uruchamiano testów aplikacji, bo research nie zmieniał implementacji. Nie przeprowadzono pełnego audytu bezpieczeństwa, zależności ani interpretacji prawnej licencji. Nie badano wszystkich dostępnych systemów: np. LangMem, MemOS, claude-mem i pozostałe pluginy nie otrzymały osobnego przeglądu ścieżek wykonania. Nie są przez to uznane za gorsze.

**Odtwarzalność źródeł.** Repozytoria pobierano jako konkretne snapshoty źródeł, bez uruchamiania ich kodu. Najważniejsze funkcje trzech finalistów porównano dodatkowo z wydaniami. Numer wydania poniżej to wynik GitHub releases/latest z dnia researchu, nie potwierdzenie, że wszystkie opisane funkcje HEAD są w tym wydaniu.

| Repozytorium | Snapshot commit | Zgłoszone latest release | Licencja snapshotu |
|---|---|---|---|
| basicmachines-co/basic-memory | `9643ec25918e8958629a668e3ce928981ab3ea36` | v0.24.1 | AGPL-3.0 / pyproject: or-later |
| tobi/qmd | `86d2365d17fc682e491c2c53d1e4a884aee8682a` | v2.8.3 | MIT |
| vectorize-io/hindsight | `5a672f0cdb89f4a3b841770cce2036a5b28b799d` | v1.1.0 | MIT |
| mem0ai/mem0 | `26cdefb46600c0fa5953c4b5ee5003c125539fc4` | ts-v3.3.1 | Apache-2.0 |
| getzep/graphiti | `5c27edfa8d3e0f49b2571bcebb4261bcc89ee037` | v0.31.2 | Apache-2.0 |
| topoteretes/cognee | `37f788bd287750e10d7610173e5332b3843f6ebd` | v1.6.6rc1 | Apache-2.0 |
| volcengine/OpenViking | `5c066d97094d713238c483c10691d7b4e1cfbf6e` | v0.5.2 | AGPL-3.0 |
| letta-ai/letta-code | `1fb6ea4d30942ef9220b096ba7f4185f18184fc1` | v0.34.24 | Apache-2.0 |

GitHub oznaczył zgłoszone wydanie Cognee jako `prerelease=false`, mimo `rc1` w nazwie; nie interpretuję go jako dowodu stabilności. SHA-256 pobranych plików, adresy źródeł i rozróżnienie HEAD/release znajdują się w [manifeście researchu](agent-memory-research-sources-2026-10-26.json).

Wysoka pewność dotyczy istnienia opisanych ścieżek bez osobnego generatywnego ekstraktora. Umiarkowana pewność dotyczy dopasowania Basic Memory do architektury Pace i tego zestawu wymagań. Neutralność łącznego usage i poprawa skuteczności pozostają nieudowodnione do czasu kontrolowanego pilota.
