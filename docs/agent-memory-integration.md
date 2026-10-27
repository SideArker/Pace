Integracja pamięci w Pace — ustalenia i proponowany podział

Status: użytkownik zaakceptował kierunek wbudowanej obsługi pamięci z opcjonalnym backendem. Ten dokument doprecyzowuje organizację i zachowanie komendy; implementacja jeszcze nie istnieje.

**Wymaganie użytkownika:** `/memory` ma otwierać interaktywny setup, jeśli pamięć nie została skonfigurowana. Nie trzeba najpierw znać komendy `/memory setup`.

**Rekomendowany podział:** kod komendy, kreatora i integracji należy do obecnego repozytorium Pace i jest publikowany z `@sidearker/pace`. Basic Memory pozostaje osobnym, opcjonalnie instalowanym programem. Pierwszy zakres obejmuje jeden backend, Basic Memory; Hindsight pozostaje kolejną integracją. Nie powstaje teraz osobne repozytorium ani paczka npm dla samego setupu. Wydzielenie adaptera do osobnej paczki będzie uzasadnione, gdy pojawi się faktyczny drugi klient albo potrzeba niezależnych wydań.

| Część | Miejsce |
|---|---|
| `/memory`, autocomplete i help | Istniejąca obsługa komend Pace |
| Interaktywny kreator i panel | Komponent Ink w Pace, zgodny ze wzorcem McpManager |
| Wykrywanie backendu, setup i sprawdzenie połączenia | Moduł integracji w Pace |
| Przechowywanie i indeksowanie notatek | Basic Memory, uruchamiany osobno |
| Konfiguracja Pace | Pod `~/.pace`, z przypisaniem do projektu |
| Dane pamięci | Osobny lokalny katalog wskazany podczas setupu; nie w paczce npm |

Backend nie jest automatycznie pobierany podczas zwykłego `npm install @sidearker/pace`. Kreator wykrywa istniejącą instalację i konfigurację. Jeśli potrzebna jest instalacja, pokazuje, co zostanie dodane, i pozwala ją rozpocząć z interfejsu. Istniejące notatki i konfiguracja backendu są zachowywane.

**Wejście przez `/memory` zależy od stanu konfiguracji bieżącego projektu.**

| Stan | Zachowanie |
|---|---|
| Brak konfiguracji | Automatyczne otwarcie kreatora |
| Konfiguracja działa | Otwarcie panelu pamięci |
| Pamięć jest wyłączona | Panel ze stanem i możliwością ponownego włączenia |
| Konfiguracja istnieje, backend nie działa | Panel naprawy połączenia; istniejące dane pozostają zachowane |
| Baza ma zero notatek | Zwykły panel pustej, poprawnie skonfigurowanej pamięci |

Brak pamięci oznacza tu brak konfiguracji, a nie brak notatek. Awaria backendu nie uruchamia od nowa pierwszej konfiguracji ani nie tworzy kolejnej pustej bazy.

**Kreator pierwszej wersji:**

1. Przedstawia Basic Memory i zakres włączenia dla bieżącego projektu.
2. Sprawdza dostępność programu i potrzebnego runtime; korzysta z istniejącej instalacji, jeśli jest dostępna.
3. Pozwala wskazać istniejącą pamięć albo utworzyć nowy katalog lokalny.
4. Pokazuje podsumowanie zmian, uruchamia potrzebną instalację i konfigurację oraz wyświetla postęp.
5. Sprawdza połączenie i dostęp do właściwego projektu. Ewentualna próba zapisu powinna używać własnego tymczasowego rekordu i go usuwać, bez modyfikowania notatek użytkownika.
6. Zapisuje działające ustawienia i przechodzi do panelu pamięci. Konfiguracja niedokończona pozostaje rozróżnialna od gotowej.

Obsługa: strzałki, Enter i Esc, zgodnie z istniejącymi panelami Pace. Anulowanie przerywa należącą do kreatora operację i zachowuje wcześniejszą konfigurację; interfejs informuje o elementach już zainstalowanych. Zmiana ustawień dotyczy kolejnych uruchomień agenta, a nie przebudowy jego połączeń w trakcie aktywnego turna.

Podstawowy panel pokazuje backend, projekt i stan połączenia oraz umożliwia włączenie/wyłączenie i ponowne przejście konfiguracji. Wyłączenie pamięci nie oznacza usunięcia danych.

**Punkty oparcia w aktualnym kodzie:** [rejestr komend](../src/components/app/commands.ts), [obsługa /mcp](../src/components/app/info-commands.ts), [widok paneli](../src/components/app/AppView.tsx), [McpManager](../src/components/McpManager.tsx), [konfiguracja MCP](../src/integrations/codex-cli.ts). To istniejące wzorce do wykorzystania; nie są implementacją `/memory`.

Warunki odbioru obejmują wejście do kreatora przy pierwszym `/memory`, otwarcie panelu po konfiguracji, odróżnienie awarii od braku konfiguracji i pustej bazy, zachowanie notatek przy anulowaniu/wyłączeniu oraz przypisanie operacji do właściwego projektu. Osobnym warunkiem całej funkcji pozostają kontrolowane zapisy/odczyty pamięci agentów i pomiar usage opisany w [researchu](agent-memory-research-2026-10-26.md).

Propozycja dostępnego tylko w debug buildzie panelu `/benchmark` i `pace benchmark`, wraz z eksperymentem A/B pamięci i pełnym rachunkiem kosztów, znajduje się w [Benchmark Center](benchmark-center.md).
