# Moteur conversationnel natif : llama.cpp (GPU Vulkan + processeur) → libvh_llm.so.
#
# Sources épinglées et vérifiées (empreinte SHA-256) ; pour travailler hors ligne,
# -DVH_LLAMA_DIR=… -DVH_VULKAN_HEADERS_DIR=… -DVH_SPIRV_HEADERS_DIR=… pointent sur des
# copies locales.
cmake_minimum_required(VERSION 3.22)
project(vh_llm C CXX)

include(FetchContent)
set(FETCHCONTENT_QUIET ON)

function(vh_source name dir_var url sha)
  if (${dir_var})
    set(${name}_SOURCE_DIR "${${dir_var}}" PARENT_SCOPE)
  else()
    FetchContent_Declare(${name} URL ${url} URL_HASH SHA256=${sha} DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
    FetchContent_GetProperties(${name})
    if (NOT ${name}_POPULATED)
      FetchContent_Populate(${name})
    endif()
    set(${name}_SOURCE_DIR "${${name}_SOURCE_DIR}" PARENT_SCOPE)
  endif()
endfunction()

if (POLICY CMP0169)
  cmake_policy(SET CMP0169 OLD)   # FetchContent_Populate : sources seules, sans add_subdirectory
endif()

vh_source(llama VH_LLAMA_DIR
  https://github.com/ggml-org/llama.cpp/archive/refs/tags/v0.6.0.tar.gz
  09b36dba235fcac180efff18514da7038e65d8e5b9e4aefa59238468abfdec12)
# vulkan.hpp n'est pas dans le NDK ; les en-têtes C du NDK sont plus anciens (1.3.275).
vh_source(vkheaders VH_VULKAN_HEADERS_DIR
  https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/v1.4.328.tar.gz
  3ad56d387179b47dd632432ccf989bbb69773e1d732692b7bbad9c4d36aa1304)
vh_source(spirvheaders VH_SPIRV_HEADERS_DIR
  https://github.com/KhronosGroup/SPIRV-Headers/archive/refs/tags/vulkan-sdk-1.4.328.0.tar.gz
  00284a33e1e19014723c8e88ca7a16e8988cd23f839ec2b7da6bb1808fd2a751)

# ── Vulkan pour Android ─────────────────────────────────────────────
# libvulkan.so du NDK (niveau d'API de la construction), glslc du NDK (machine hôte),
# en-têtes Khronos. ggml-vulkan exige find_package(SPIRV-Headers) : une configuration
# minimale suffit, il n'utilise que ses en-têtes.
string(TOLOWER "${CMAKE_HOST_SYSTEM_NAME}" vh_host)
file(GLOB vh_glslc "${ANDROID_NDK}/shader-tools/${vh_host}-*/glslc")
set(Vulkan_GLSLC_EXECUTABLE "${vh_glslc}" CACHE FILEPATH "" FORCE)
set(Vulkan_INCLUDE_DIR "${vkheaders_SOURCE_DIR}/include" CACHE PATH "" FORCE)
find_library(Vulkan_LIBRARY vulkan REQUIRED)
set(vh_spirv_cfg "${CMAKE_CURRENT_BINARY_DIR}/spirv-headers-config")
file(WRITE "${vh_spirv_cfg}/SPIRV-HeadersConfig.cmake" "# en-têtes seuls : include_directories ci-dessous\n")
set(SPIRV-Headers_DIR "${vh_spirv_cfg}" CACHE PATH "" FORCE)
include_directories(BEFORE "${vkheaders_SOURCE_DIR}/include" "${spirvheaders_SOURCE_DIR}/include")

# ── Outil hôte des nuanceurs Vulkan ─────────────────────────────────
# En compilation croisée, llama.cpp construit un outil HÔTE (vulkan-shaders-gen) qui
# traduit les nuanceurs GLSL en SPIR-V. Le fichier de chaîne d'outils qu'il génère
# lui-même ne renseigne pas CMAKE_MAKE_PROGRAM, et le ninja du SDK Android n'est pas
# dans le PATH de Gradle : la configuration échouait (« CMake was unable to find a
# build program corresponding to "Ninja" »). On fournit donc le fichier, en reprenant
# le sien et en y ajoutant ninja — GGML_VULKAN_SHADERS_GEN_TOOLCHAIN évite son
# détecteur de compilateur hôte (voir ggml/src/ggml-vulkan/CMakeLists.txt).
if (CMAKE_CROSSCOMPILING)
  if (NOT GGML_VULKAN_SHADERS_GEN_TOOLCHAIN)
    if (CMAKE_MAKE_PROGRAM)
      set(vh_ninja "${CMAKE_MAKE_PROGRAM}")
    else()
      get_filename_component(vh_cmake_bin "${CMAKE_COMMAND}" DIRECTORY)
      find_program(vh_ninja ninja HINTS "${vh_cmake_bin}" REQUIRED)
    endif()
    find_program(vh_host_cc NAMES gcc cc clang REQUIRED)
    find_program(vh_host_cxx NAMES g++ c++ clang++ REQUIRED)
    file(WRITE "${CMAKE_BINARY_DIR}/vh-host-toolchain.cmake" "\
set(CMAKE_BUILD_TYPE Release)
set(CMAKE_C_FLAGS -O2)
set(CMAKE_CXX_FLAGS -O2)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE NEVER)
set(CMAKE_C_COMPILER \"${vh_host_cc}\")
set(CMAKE_CXX_COMPILER \"${vh_host_cxx}\")
set(CMAKE_MAKE_PROGRAM \"${vh_ninja}\" CACHE FILEPATH \"ninja de l'hote\" FORCE)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_RUNTIME_OUTPUT_DIRECTORY})
")
    set(GGML_VULKAN_SHADERS_GEN_TOOLCHAIN "${CMAKE_BINARY_DIR}/vh-host-toolchain.cmake"
        CACHE FILEPATH "chaîne d'outils de l'outil hôte" FORCE)
  endif()
endif()

# ── llama.cpp ───────────────────────────────────────────────────────
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_APP OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN ON CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_LLAMAFILE OFF CACHE BOOL "" FORCE)
# Produit scalaire 8 bits (Q4_0) et demi-précision : Snapdragon 845 et suivants.
# LlmNative ne charge la bibliothèque que si le processeur annonce asimddp et asimdhp.
set(GGML_CPU_ARM_ARCH "armv8.2-a+dotprod+fp16" CACHE STRING "" FORCE)
add_subdirectory("${llama_SOURCE_DIR}" llama EXCLUDE_FROM_ALL)

# ── libvh_llm.so ───────────────────────────────────────────────────
add_library(vh_llm SHARED vh_llm.cpp vh_llm_jni.cpp)
target_compile_features(vh_llm PRIVATE cxx_std_17)
target_link_libraries(vh_llm PRIVATE llama ggml android log)
target_link_options(vh_llm PRIVATE -Wl,--gc-sections -Wl,--exclude-libs,ALL)
