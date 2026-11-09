# Builds the portable core, the host simulator and the unit tests.
# Works with GNU make on Linux/macOS and mingw32-make on Windows.
#
#   make            build sim + tests
#   make test       run unit tests
#   make sanitize   run unit tests under ASan/UBSan (Linux/macOS)

CC      ?= cc
CSTD    := -std=c99
WARN    := -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion -Werror
CFLAGS  ?= -O2 -g
CFLAGS  += $(CSTD) $(WARN) -Icore/include
BUILD   := build

ifeq ($(OS),Windows_NT)
  EXE    := .exe
  LDLIBS := -lws2_32 -lm
  MKDIR  = if not exist $(subst /,\,$(1)) mkdir $(subst /,\,$(1))
  RMDIR  = if exist $(BUILD) rmdir /s /q $(BUILD)
else
  EXE    :=
  LDLIBS := -lm
  MKDIR  = mkdir -p $(1)
  RMDIR  = rm -rf $(BUILD)
endif

CORE_SRC := core/src/mqtt.c core/src/outbox.c core/src/backoff.c core/src/sensors.c
SIM_SRC  := sim/main.c sim/device.c sim/platform.c

SIM  := $(BUILD)/pulse-sim$(EXE)
TEST := $(BUILD)/test_core$(EXE)

.PHONY: all test sanitize clean

all: $(SIM) $(TEST)

$(SIM): $(CORE_SRC) $(SIM_SRC) $(wildcard core/include/pulse/*.h sim/*.h)
	@$(call MKDIR,$(BUILD))
	$(CC) $(CFLAGS) -Isim -o $@ $(CORE_SRC) $(SIM_SRC) $(LDLIBS)

$(TEST): $(CORE_SRC) tests/test_core.c $(wildcard core/include/pulse/*.h)
	@$(call MKDIR,$(BUILD))
	$(CC) $(CFLAGS) -o $@ $(CORE_SRC) tests/test_core.c $(LDLIBS)

test: $(TEST)
	$(TEST)

sanitize:
	@$(call MKDIR,$(BUILD))
	$(CC) $(CSTD) $(WARN) -Icore/include -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer \
	  -o $(BUILD)/test_core_san $(CORE_SRC) tests/test_core.c -lm
	$(BUILD)/test_core_san

clean:
	$(RMDIR)
