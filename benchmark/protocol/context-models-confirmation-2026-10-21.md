# Zamrożenie i wybór potwierdzenia — 2026-10-21

Wybór następuje po ukończeniu 16 odrębnych wariantów pilota, przed pierwszym uruchomieniem scenariusza holdout. Zachowane są także wcześniejsze 16 awarii konfiguracji i jedna próba przerwana limitem. Dokończenie czterech wariantów po nowym zleceniu użytkownika nie zastępuje wcześniejszych ukończonych wyników.

Rozliczenie bazuje wyłącznie na usage przypisanym do ID aktywnej tury. Oryginalne run.json zachowano; accounting-corrected.json zawiera poprawione sumy i hashe korekty. Koszt natywnej kompakcji jest nieznany, ponieważ App Server zwraca placeholder billingowy. Wybór nie opiera się na wcześniejszych, zawyżonych kwotach ani na założeniu zerowego kosztu kompakcji.

## Zastosowanie zapisanej reguły

Najpierw wymagamy poprawnego kodu, zachowanych ograniczeń i poprawnej notatki/podsumowania. Następnie porównujemy sumę kosztów od interwencji na obu przypadkach pilota. Czas rozstrzyga tylko różnicę kosztu mniejszą niż 5%. Wybieramy najtańszą kwalifikującą się **alternatywę** dla bazowego wariantu; nie nazywamy jej zwycięzcą wobec bazy.

- A: baza `resume`, alternatywa `fresh_checkpoint` z autorem Sol. Obie notatki i implementacje przeszły ocenę. Suma kosztów po interwencji: resume 0,088158 USD, fresh checkpoint 0,1863372 USD, fresh replay 0,2195768 USD. Kompakcja ma nieznany pełny koszt; już znany subtotal dalszej pracy, 0,2016132 USD, przekracza resume. Wybrany checkpoint jest najtańszą poprawną, w pełni wycenioną alternatywą, choć w pilocie droższą od bazy.
- B: baza `sol`, alternatywa `luna_side`. Podsumowania i dalszy kod obu wariantów są poprawne. Suma kosztów po interwencji: sol 0,0939568 USD, luna side 0,1069987 USD, luna main 0,1463397 USD. Side jest najtańszą poprawną alternatywą, ale wynik różni się między małym i dłuższym przypadkiem. Część pilota wykonano po wznowieniu następnego dnia; potwierdzenie tworzy nowe niezależne pary w jednym okresie pomiarowym.
- C: końcowy kod jest poprawny u obu autorów. Luna obniżyła koszt całej kontynuacji z 0,0986832 do 0,0776961 USD. Jej notatka dopisała jednak nieuzasadnioną niepewność co do wymagania pól endpoint i retries. To uchybienie wierności notatki, nie błąd końcowej implementacji ani krytyczna utrata całego kontraktu. Według ostrożnej, jawnej oceny jakości notatka nie przechodzi pełnego kryterium. Nie wybieramy jej do potwierdzenia jako optymalizacji. Autor checkpointu pozostaje pytaniem wymagającym dalszego badania; wyników A/B nie użyjemy jako potwierdzenia C.

## Zamrożona macierz

Potwierdzenie obejmuje wyłącznie A i B: dwa wcześniej odłożone scenariusze × dwie wybrane trasy w rodzinie × trzy powtórzenia = 24 wykonania scenariusza, 126 tur modelu, maksymalnie sześć dodatkowych napraw checkpointu. Scenariusze to `holdout-dispatch` i `holdout-session-cache`. Nie wykonano ich ani razu przed tym wyborem.

Przed wykonaniem poprawiono oczywistą dwuznaczność statycznego polecenia holdout-dispatch: zamiast „Reject ... nonnegative noninteger counts” polecenie jawnie wymaga „count to be a nonnegative integer”. Asercje i rubryka od początku wymagają odrzucenia ujemnych i niecałkowitych liczb. Nie zmieniono scenariuszy pilota ani kryteriów na podstawie wykonania holdout.

Kolejność: powtórzenie, rodzina A/B, scenariusz dispatch/session-cache, warianty. Pierwsze i trzecie powtórzenie wykonuje bazę przed alternatywą; drugie odwraca kolejność. Plan jest zapisany w confirmation-plan.json, a właściwy manifest zapisze pełną kolejność przed wywołaniami modeli.

Nie dostrajamy promptów, tras, effortów, progów ani kodu wykonawczego po rozpoczęciu potwierdzenia. Ewentualna naprawa błędu infrastruktury wymaga osobnego zapisu i jawnego określenia wpływu na porównywalność. Obowiązuje wcześniejsza zasada zatrzymania na limicie lub powtarzających się awariach dostępu. Nie obiecujemy potwierdzenia całej rodziny ani niezawodności na podstawie sześciu par.
