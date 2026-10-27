cmake_minimum_required(VERSION 3.16)
project(we_reactor LANGUAGES CXX)

# 独立构建（cmake -S we_reactor -B build）时的默认设置；
# 被 server/CMakeLists.txt 通过 add_subdirectory 引入时，沿用外层的 C++ 标准与构建类型。
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    set(CMAKE_CXX_STANDARD 14)
    set(CMAKE_CXX_STANDARD_REQUIRED ON)
    if(NOT CMAKE_BUILD_TYPE)
        set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
    endif()
endif()

# 服务端只需要 re_reactor / re_proto 两个库，会把它关掉，避免引入 MySQL 依赖
option(WE_REACTOR_BUILD_BINS "构建 re_dns / re_reporter / re_lb_agent 三个可执行体" ON)

set(WE_REACTOR_ROOT ${CMAKE_CURRENT_SOURCE_DIR})
set(RE_BASE ${WE_REACTOR_ROOT}/base)

find_package(Protobuf REQUIRED)
find_package(Threads REQUIRED)

# ---------------------------------------------------------------------------
# 协议：base/proto/re.proto（protobuf 包名 re），生成 re.pb.{h,cc}
# ---------------------------------------------------------------------------
protobuf_generate_cpp(RE_PROTO_SRCS RE_PROTO_HDRS ${RE_BASE}/proto/re.proto)
add_library(re_proto STATIC ${RE_PROTO_SRCS} ${RE_PROTO_HDRS})
target_include_directories(re_proto PUBLIC ${CMAKE_CURRENT_BINARY_DIR})
target_link_libraries(re_proto PUBLIC protobuf::libprotobuf)

# ---------------------------------------------------------------------------
# 网络库：re_reactor（事件循环 / TCP·UDP 连接 / 线程池）
#   注意：本目录代码较老，用了 <ext/hash_map> 等已废弃接口，故屏蔽 deprecation 警告
# ---------------------------------------------------------------------------
file(GLOB RE_REACTOR_SRCS ${WE_REACTOR_ROOT}/re_reactor/src/*.cpp)
add_library(re_reactor STATIC ${RE_REACTOR_SRCS})
target_include_directories(re_reactor PUBLIC ${WE_REACTOR_ROOT}/re_reactor/include)
target_compile_options(re_reactor PRIVATE -Wno-deprecated)
target_link_libraries(re_reactor PUBLIC Threads::Threads ${CMAKE_DL_LIBS} protobuf::libprotobuf)

# ---------------------------------------------------------------------------
# 三个可执行体：re_dns（route-dns）/ re_reporter（route-reporter）/ re_lb_agent（route-agent）
#   它们都用 MySQL C 客户端读路由表 / 上报统计
# ---------------------------------------------------------------------------
if(WE_REACTOR_BUILD_BINS)
    find_path(MYSQL_INCLUDE_DIR NAMES mysql.h PATH_SUFFIXES mysql)
    find_library(MYSQL_LIBRARY NAMES mysqlclient)
    if(NOT MYSQL_INCLUDE_DIR OR NOT MYSQL_LIBRARY)
        message(FATAL_ERROR
            "we_reactor: 找不到 MySQL C 客户端（mysql.h / libmysqlclient）。\n"
            "  Ubuntu: apt-get install -y libmysqlclient-dev")
    endif()

    # MySQL 8 的 mysql.h 已删除 my_bool，而本目录代码仍在使用，故统一别名到 bool
    set(RE_BIN_LIBS ${MYSQL_LIBRARY} ssl crypto zstd m resolv Threads::Threads ${CMAKE_DL_LIBS})

    foreach(mod IN ITEMS re_dns re_reporter re_lb_agent)
        file(GLOB RE_MOD_SRCS ${WE_REACTOR_ROOT}/${mod}/src/*.cpp)
        add_executable(${mod} ${RE_MOD_SRCS})
        target_include_directories(${mod} PRIVATE
            ${WE_REACTOR_ROOT}/${mod}/include
            ${MYSQL_INCLUDE_DIR})
        target_compile_definitions(${mod} PRIVATE my_bool=bool)
        target_compile_options(${mod} PRIVATE -Wno-deprecated)
        target_link_libraries(${mod} PRIVATE re_reactor re_proto ${RE_BIN_LIBS})
        # 产物统一放到 build/bin，便于 Dockerfile 直接 COPY
        set_target_properties(${mod} PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
    endforeach()
endif()
