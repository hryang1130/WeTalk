TARGET= bin/re_lb_agent
CXX=g++
CFLAGS=-g -O2 -Wall -Wno-deprecated -Dmy_bool=bool

BASE=../base
BASE_H=$(BASE)/include

PROTO = $(BASE)/proto
PROTO_H = $(BASE)/proto

RE_ACTOR=../re_reactor
RE_ACTOR_H =$(RE_ACTOR)/include
RE_ACTOR_LIB=$(RE_ACTOR)/lib  -lre_reactor

MYSQL=$(BASE)/mysql-connector-c
MYSQL_H=$(MYSQL)/include
MYSQL_LIB=$(MYSQL)/lib/libmysqlclient.a

OTHER_LIB = -lpthread -ldl -lprotobuf -lssl -lcrypto -lzstd -lm -lresolv
SRC= ./src
INC= -I./include -I$(BASE_H) -I$(RE_ACTOR_H) -I$(MYSQL_H) -I$(PROTO_H)

LIB= $(MYSQL_LIB) -L$(RE_ACTOR_LIB) $(OTHER_LIB) 


OBJS = $(addsuffix .o, $(basename $(wildcard $(SRC)/*.cpp)))
OBJS += $(PROTO)/re.pb.o

$(TARGET): $(OBJS)
	mkdir -p bin
	$(CXX) $(CFLAGS) -o $(TARGET) $(OBJS) $(INC) $(LIB)

%.o: %.cpp
	$(CXX) $(CFLAGS) -c -o $@ $< $(INC) 

.PHONY: clean

clean:
	-rm -f src/*.o  $(PROTO)/re.pb.o $(TARGET)
